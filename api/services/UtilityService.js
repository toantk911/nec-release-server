/**
 * A simple service for making reusable helper functions globaly available yet
 * namespaced
 */

var _ = require('lodash');
var semver = require('semver');

var UtilityService = {};

UtilityService.getTruthyObject = function(object) {
  return _.pickBy(object, _.identity);
};

/**
 * Compare version objects using semantic versioning.
 * Pass to Array.sort for a descending array
 * @param  {Object} v1 Version object one
 * @param  {Object} v2 Version object two
 * @return {-1|0|1}    Whether one is is less than or greater
 */
UtilityService.compareVersion = function(v1, v2) {
  return -semver.compare(v1.name, v2.name);
};

/**
 * Get client's ip address from its request
 * @param {Object}  req Request from client
 * @return {string}     Ip address
 */
UtilityService.getClientIp = function(req) {
  return req.headers['x-forwarded-for'] || req.connection.remoteAddress || req.socket.remoteAddress || req.connection.socket.remoteAddress;
};

module.exports = UtilityService;
