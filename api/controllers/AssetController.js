/**
 *  AssetController
 *
 * @description :: Server-side logic for managing assets
 * @help        :: See http://sailsjs.org/#!/documentation/concepts/Controllers
 */

var _ = require('lodash');
var url = require('url');
var path = require('path');
var actionUtil = require('sails/lib/hooks/blueprints/actionUtil');
var Promise = require('bluebird');

var SEGMENTS_TO_REMOVE = _.concat(_.pickBy(PlatformService, _.isString), [
  'x64',
  'ia32',
  'x32',
  'win32',
  'windows',
  'osx',
  'linux'
]);

module.exports = {

  /**
   * Download a release artifact
   *
   * Note: if a filename is specified, nothing but the filetype is used.
   * This is because Squirrel.Windows does a poor job of parsing the filename,
   * and so we must fake the filenames of x32 and x64 versions to be the same.
   *
   * (GET /download/latest/:platform?': 'AssetController.download')
   * (GET /download/:version/:platform?/:filename?': 'AssetController.download')
   * (GET /download/channel/:channel/:platform?': 'AssetController.download')
   */
  download: function (req, res) {
    var ip = UtilityService.getClientIp(req);
    var channel = req.params.channel;
    var version = req.params.version || undefined;
    var filename = req.params.filename;
    var filetype = req.query.filetype;

    // We accept multiple platforms (x64 implies x32)
    var platforms;
    var platform = req.param('platform');
    if (platform) {
      platforms = [platform];
    }

    // Normalize filetype by prepending with period
    if (_.isString(filetype) && filetype[0] !== '.') {
      filetype = '.' + filetype;
    } else if (filename) {
      filetype = filename.substr(filename.lastIndexOf('.'));
    }

    // Detect platform from useragent
    if (!platforms) {
      platforms = PlatformService.detectFromRequest(req);

      if (!platforms) {
        return res.serverError(
          'No platform specified and detecting one was unsuccessful.'
        );
      }
    } else {
      platforms = PlatformService.sanitize(platforms);
    }

    if (!version) {
      channel = channel || 'stable';
    }

    var assetPromise = new Promise(function (resolve, reject) {
      IpAddress
        .findOne(ip)
        .then(function (ipAddress) {
          var cacheId = ipAddress ? ipAddress.cache : sails.config.defaultCache;

          var assetOptions = UtilityService.getTruthyObject({
            platform: platforms,
            filetype: filetype,
            cache: cacheId
          });

          sails.log.debug('Asset requested with options', assetOptions);

          if (version || channel) {
            Version
              .find(UtilityService.getTruthyObject({
                name: version,
                channel: channel
              }))
              .sort({
                createdAt: 'desc'
              })
              .limit(1)
              .populate('assets', assetOptions)
              .then(function (versions) {
                if (!versions || !versions.length) {
                  return resolve();
                }

                var version = versions[0];

                if (!version.assets || !version.assets.length) {
                  return resolve();
                }

                // Sorting filename in ascending order prioritizes other files
                // over zip archives is both are available and matched.
                return resolve(_.orderBy(
                  version.assets, ['filetype', 'createdAt'], ['asc', 'desc']
                )[0]);
              })
              .catch(reject);
          } else {
            Asset
              .find(assetOptions)
              .sort({
                createdAt: 'desc'
              })
              .limit(1)
              .then(resolve)
              .catch(reject);
          }
        });
    })
      .then(function (asset) {
        if (!asset || !asset.fd) {
          var noneFoundMessage = 'No download available';

          if (platforms) {
            if (platforms.length > 1) {
              noneFoundMessage += ' for platforms ' + platforms.toString();
            } else {
              noneFoundMessage += ' for platform ' + platforms[0];
            }
          }

          noneFoundMessage += version ? ' for version ' + version : '';
          noneFoundMessage += ' (' + channel + ') ';
          noneFoundMessage += filename ? ' with filename ' + filename : '';
          noneFoundMessage += filetype ? ' with filetype ' + filetype : '';
          return res.notFound(noneFoundMessage);
        }

        // Serve asset & log analytics
        return AssetService.serveFile(req, res, asset);
      })
      // Catch any unhandled errors
      .catch(res.negotiate);
  },

  create: function (req, res) {
    // Create data object (monolithic combination of all parameters)
    // Omit the blacklisted params (like JSONP callback param, etc.)
    var data = actionUtil.parseValues(req);

    if (!data.version) {
      return res.badRequest('A version is required.');
    }

    if (_.isString(data.version)) {
      // Only a name was provided, normalize
      data.version = {
        name: data.version
      };
    } else if (_.isObjectLike(data.version) && _.has(data.version, 'name')) {
      // Valid request, but we only want the name
      data.version = {
        name: data.version.name
      };
    } else {
      return res.badRequest('Invalid version provided.');
    }

    // Set upload request timeout to 10 minutes
    req.setTimeout(10 * 60 * 1000);

    req.file('file').upload(sails.config.files,
      function whenDone(err, uploadedFiles) {
        if (err) {
          return res.negotiate(err);
        }

        // If an unexpected number of files were uploaded, respond with an
        // error.
        if (uploadedFiles.length !== 1) {
          return res.badRequest('No file was uploaded');
        }

        var uploadedFile = uploadedFiles[0];

        var fileExt = path.extname(uploadedFile.filename);
        var fileRelativePath = uploadedFile.fd.replace(path.join(sails.config.files.dirname), '');

        sails.log.debug('Creating asset with name', uploadedFile.filename);

        var hashPromise;

        if (fileExt === '.nupkg') {
          // Calculate the hash of the file, as it is necessary for windows
          // files
          hashPromise = AssetService.getHash(uploadedFile.fd);
        } else {
          hashPromise = Promise.resolve('');
        }

        hashPromise
          .then(function (fileHash) {
            // Create new instance of model using data from params
            Asset
              .create(_.merge({
                name: uploadedFile.filename,
                hash: fileHash,
                filetype: fileExt,
                fd: fileRelativePath,
                size: uploadedFile.size,
                cache: sails.config.defaultCache
              }, data))
              .exec(function created(err, newInstance) {

                // Differentiate between waterline-originated validation errors
                // and serious underlying issues. Respond with badRequest if a
                // validation error is encountered, w/ validation info.
                if (err) return res.negotiate(err);

                // If we have the pubsub hook, use the model class's publish
                // method to notify all subscribers about the created item.
                if (req._sails.hooks.pubsub) {
                  if (req.isSocket) {
                    Asset.subscribe(req, newInstance);
                    Asset.introduce(newInstance);
                  }
                  Asset.publishCreate(newInstance, !req.options.mirror && req);
                }
              });

            // Get cache list and copy asset to caches via FTP
            Cache
              .find({})
              .then(function (caches) {
                var copyPromises = _.map(caches, function (cache) {
                  if (cache.cacheId !== sails.config.defaultCache) {
                    sails.log.debug('Copying asset to cache', cache.cacheName);
                    var remote_file = path.join(cache.assetFtpPath, fileRelativePath);

                    return new Promise(function (resolve, reject) {
                      AssetService.ftpUpload(uploadedFile.fd, remote_file, cache.cacheIP, cache.cachePort, cache.ftpUploadUser, cache.ftpUploadPassword)
                        .then(function uploadDone(result) {
                          Asset
                            .create(_.merge({
                              name: uploadedFile.filename,
                              hash: fileHash,
                              filetype: fileExt,
                              fd: fileRelativePath,
                              size: uploadedFile.size,
                              cache: cache.cacheId
                            }, data))
                            .exec(function created(err, newInstance) {
                              if (err) return res.negotiate(err);

                              if (req._sails.hooks.pubsub) {
                                if (req.isSocket) {
                                  Asset.subscribe(req, newInstance);
                                  Asset.introduce(newInstance);
                                }
                                Asset.publishCreate(newInstance, !req.options.mirror && req);
                              }

                              resolve('');
                            });
                        })
                        .catch(res.negotiate);
                    });
                  }
                });

                // Use Promise.all() for uploading parallel or
                // use Promise.each() for uploading serially. 
                Promise.all(copyPromises)
                  .then(function allCacheCopied() {
                    // Send JSONP-friendly response if it's supported
                    res.created({});
                  });
              });
          })
          .catch(res.negotiate);
      });
  },

  destroy: function (req, res) {
    var pk = actionUtil.requirePk(req);

    var query = Asset.findOne(pk);
    query.populate('version');
    query
      .then(function foundRecord(record) {
        if (!record) return res.notFound(
          'No record found with the specified `name`.'
        );

        // Delete the file & remove from db
        return Promise.join(
          AssetService.destroy(record, req),
          AssetService.deleteFile(record),
          function () { })
          .then(function success() {
            res.ok(record);
          });
      })
      .error(res.negotiate);
  }

};
