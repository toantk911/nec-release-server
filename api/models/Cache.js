/**
 * Cache.js
 *
 * @description :: Represents a cache that contains physical assets
 * @docs        :: http://sailsjs.org/#!documentation/models
 */

module.exports = {

    attributes: {
        cacheId: {
            type: 'integer',
            primaryKey: true,
            unique: true,
            required: true,
            autoIncrement: true
        },

        cacheName: {
            type: 'string',
            required: true,
        },

        cacheIP: {
            type: 'string',
            required: true,
        },

        cachePort: {
            type: 'string',
            required: true,
        },

        ftpUploadUser: {
            type: 'string',
            required: true,
        },

        ftpUploadPassword: {
            type: 'string',
            required: true,
        },

        externalIP: {
            type: 'string'
        },

        assetFtpPath: {
            type: 'string',
            required: true,
        },

        assetHttpUrl: {
            type: 'string',
            required: true,
        }
    },
    autoPK: false

};
