/**
 * File Service
 *
 * Handles uploads & downloads of versions
 */

var mime = require('mime');
var path = require('path');

var fsx = require('fs-extra');
var crypto = require('crypto');
var Promise = require('bluebird');

var SkipperDisk = require('skipper-disk');

var FtpClient = require("ftp");

var AssetService = {};

AssetService.serveFile = function (req, res, asset) {
  Asset
    .findOne(asset.id)
    .populate('cache')
    .then(function (asset) {
      if (asset.cache.cacheId === sails.config.defaultCache && !asset.cache.assetHttpUrl) {
        // Serve file directly if has no url
        var assetPath = path.join(sails.config.files.dirname, asset.fd);
        // Stream the file to the user
        var fileStream = fsx.createReadStream(assetPath)
          .on('error', function (err) {
            res.serverError('An error occurred while accessing asset.', err);
            sails.log.error('Unable to access asset:', assetPath);
          })
          .on('open', function () {
            // Send file properties in header
            res.setHeader(
              'Content-Disposition', 'attachment; filename="' + asset.name + '"'
            );
            res.setHeader('Content-Length', asset.size);
            res.setHeader('Content-Type', mime.lookup(assetPath));
          })
          .on('end', function complete() {
            AssetService.countDownload(asset);
          })
          // Pipe to user
          .pipe(res);
      }
      else {
        AssetService.countDownload(asset);

        var redirectUrl = url.resolve(asset.cache.assetHttpUrl, asset.fd);
        res.redirect(302, redirectUrl);
      }
    });
};

/**
 * Asyncronously generates a SHA1 hash from a file
 * @param  {String} fd File descriptor of file to hash
 * @return {String}    Promise which is resolved with the hash once complete
 */
AssetService.getHash = function (fd) {
  return new Promise(function (resolve, reject) {

    var hash = crypto.createHash('sha1');
    hash.setEncoding('hex');

    var fileStream = fsx.createReadStream(fd)
      .on('error', function (err) {
        reject(err);
      })
      .on('end', function () {
        hash.end();
        resolve(String.prototype.toUpperCase.call(hash.read()));
      })
      // Pipe to hash generator
      .pipe(hash);
  });
};


/**
 * Deletes an asset from the database.
 * Warning: this will NOT remove fd from the file system.
 * @param   {Record}  asset The asset's record object from sails
 * @param   {Object}  req   Optional: The request object
 * @returns {Promise}       Resolved once the asset is destroyed
 */
AssetService.destroy = function (asset, req) {
  if (!asset) {
    throw new Error('You must pass an asset');
  }

  return Asset.destroy(asset.id)
    .then(function destroyedRecord() {
      if (sails.hooks.pubsub) {
        Asset.publishDestroy(
          asset.name, !req._sails.config.blueprints.mirror && req, {
            previous: asset
          }
        );

        if (req && req.isSocket) {
          Asset.unsubscribe(req, record);
          Asset.retire(record);
        }
      }
    });
};

/**
 * Deletes an asset's file from the filesystem.
 * Warning: this will NOT remove the reference to the fd in the database.
 * @param   {Object}  asset The asset object who's file we would like deleted
 * @returns {Promise}       Resolved once the file is deleted
 */
AssetService.deleteFile = function (asset) {
  if (!asset) {
    throw new Error('You must pass an asset');
  }
  if (!asset.fd) {
    throw new Error('The provided asset does not have a file descriptor');
  }

  if (asset.cache === sails.config.defaultCache) {
    var fileAdapter = SkipperDisk();
    var fileAdapterRmAsync = Promise.promisify(fileAdapter.rm);

    var assetPath = path.join(sails.config.files.dirname, asset.fd);
    return fileAdapterRmAsync(assetPath);
  }
  else {
    return Cache
      .findOne(asset.cache)
      .then(function (cache) {
        var remote_file = path.join(cache.assetFtpPath, asset.fd);
        return AssetService.ftpDelete(remote_file, cache.cacheIP, cache.cachePort, cache.ftpUploadUser, cache.ftpUploadPassword);
      });
  }
};

/**
 * Atomically increment the download count for analytics purposes
 * @param   {Record}  asset The asset's record object from sails
 */
AssetService.countDownload = function (asset) {
  // After we have sent the file, log analytics, failures experienced at
  // this point should only be handled internally (do not use the res
  // object).
  //
  // Atomically increment the download count for analytics purposes
  //
  // Warning: not all adapters support queries
  if (_.isFunction(Asset.query)) {
    Asset.query(
      'UPDATE asset SET download_count = download_count + 1 WHERE id = \'' + asset.id + '\';',
      function (err) {
        if (err) {
          sails.log.error(
            'An error occurred while logging asset download', err
          );
        }
      });
  } else {
    asset.download_count++;

    Asset.update({
      id: asset.id
    }, asset)
      .exec(function (err) {
        if (err) {
          sails.log.error(
            'An error occurred while logging asset download', err
          );
        }
      });
  }
};

/**
 * Upload file via FTP
 * @param   {string}  local_file  The path of file at local
 * @param   {string}  remote_file The path of file at FTP folder
 * @param   {string}  host        The IP address of FTP server
 * @param   {number}  port        The port of FTP server
 * @param   {string}  user        The username to upload via FTP
 * @param   {string}  password    The password to upload via FTP
 */
AssetService.ftpUpload = function (local_file, remote_file, host, port, user, password) {
  if (!port) { port = 21; }

  return new Promise(function (resolve, reject) {
    var client = new FtpClient();
    client.on('ready', function () {
      var savepath = path.dirname(remote_file);
      client.mkdir(savepath, function (mkdirError) {
        client.put(local_file, remote_file, function (error) {
          client.end();
          if (error) {
            sails.log.error('An error occurred while copying asset to ' + host, error);
            reject(error);
          }
          else {
            resolve('');
          }
        });
      });
    });
    client.on('error', function (error) {
      client.end();
      sails.log.error('An error occurred while copying asset to ' + host, error);
      reject(error);
    });
    client.connect({
      host: host,
      port: port,
      user: user,
      password: password
    });
  });
};

AssetService.ftpDelete = function (remote_file, host, port, user, password) {
  if (!port) { port = 21; }

  return new Promise(function (resolve, reject) {
    var client = new FtpClient();
    client.on('ready', function () {
      client.delete(remote_file, function (error) {
        client.end();
        if (error) {
          sails.log.error('An error occurred while deleting asset at ' + host, error);
          reject(error);
        }
        else {
          resolve('');
        }
      });
    });
    client.on('error', function (error) {
      client.end();
      sails.log.error('An error occurred while deleting asset at ' + host, error);
      reject(error);
    });
    client.connect({
      host: host,
      port: port,
      user: user,
      password: password
    });
  });
};

module.exports = AssetService;
