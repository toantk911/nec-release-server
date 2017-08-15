/**
 * IpAddress.js
 *
 * @description :: Represents a mapping between client's IP and server cache
 * @docs        :: http://sailsjs.org/#!documentation/models
 */

module.exports = {

    attributes: {
        ipAddress: {
            type: 'string',
            primaryKey: true,
            unique: true,
            required: true,
        },

        cacheId: {
            type: 'integer',
            required: true,
        }
    },
    autoPK: false

};
