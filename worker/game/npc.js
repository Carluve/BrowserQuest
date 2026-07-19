/* Ported from server/js/npc.js */
var Entity = require("./entity");

var Npc = Entity.extend({
    init: function (id, kind, x, y) {
        this._super(id, "npc", kind, x, y);
    }
});

globalThis.Npc = Npc;
module.exports = Npc;
