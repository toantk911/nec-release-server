/**
 * AssetCache.js
 *
 * @description :: Represents a physical file of asset on servr cache
 * @docs        :: http://sailsjs.org/#!documentation/models
 */

module.exports = {

    attributes: {
        asset: {
            model: 'asset'
        },

        cache: {
            model: 'cache'
        }
    }

};
