/* Simple JavaScript Inheritance
 * By John Resig http://ejohn.org/  (MIT Licensed)
 *
 * Rewritten to be strict-mode safe for the Cloudflare Workers bundler:
 *  - no assignment to an implicit global `Class`
 *  - no `arguments.callee` (forbidden in strict mode)
 * Behaviour (including the `this._super(...)` mechanism) is preserved.
 */
var initializing = false,
    fnTest = /xyz/.test(function () { return xyz; }) ? /\b_super\b/ : /.*/;

function Class() {}

function extend(prop) {
    var _super = this.prototype;

    // Instantiate a base class (but only create the instance,
    // don't run the init constructor).
    initializing = true;
    var prototype = new this();
    initializing = false;

    // Copy the properties over onto the new prototype.
    for (var name in prop) {
        prototype[name] = typeof prop[name] == "function" &&
            typeof _super[name] == "function" && fnTest.test(prop[name]) ?
            (function (name, fn) {
                return function () {
                    var tmp = this._super;

                    // Add a new ._super() method that is the same method
                    // but on the super-class.
                    this._super = _super[name];

                    var ret = fn.apply(this, arguments);
                    this._super = tmp;

                    return ret;
                };
            })(name, prop[name]) :
            prop[name];
    }

    function NewClass() {
        if (!initializing && this.init) {
            this.init.apply(this, arguments);
        }
    }

    NewClass.prototype = prototype;
    NewClass.prototype.constructor = NewClass;
    NewClass.extend = extend;

    return NewClass;
}

Class.extend = extend;

module.exports = { Class: Class };
