/* Ported from server/js/chestarea.js */
var _ = require("underscore"),
    Types = require("./gametypes"),
    Area = require("./area");

var ChestArea = Area.extend({
    init: function (id, x, y, width, height, cx, cy, items, world) {
        this._super(id, x, y, width, height, world);
        this.items = items;
        this.chestX = cx;
        this.chestY = cy;
    },

    contains: function (entity) {
        if (entity) {
            return entity.x >= this.x
                && entity.y >= this.y
                && entity.x < this.x + this.width
                && entity.y < this.y + this.height;
        } else {
            return false;
        }
    }
});

globalThis.ChestArea = ChestArea;
module.exports = ChestArea;
