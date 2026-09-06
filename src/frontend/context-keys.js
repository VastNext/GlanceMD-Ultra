(function (root) {
  'use strict';
  function ContextKeyService(parent) {
    this.parent = parent || null;
    this.values = Object.create(null);
    this.listeners = [];
    this.children = [];
    if (this.parent) this.parent.children.push(this);
  }
  ContextKeyService.prototype.createChild = function () { return new ContextKeyService(this); };
  ContextKeyService.prototype.get = function (key) {
    if (Object.prototype.hasOwnProperty.call(this.values, key)) return this.values[key];
    return this.parent ? this.parent.get(key) : undefined;
  };
  ContextKeyService.prototype.set = function (key, value) {
    var old = this.get(key); this.values[key] = value;
    if (old !== value) this._notify(key, value, old);
    return value;
  };
  ContextKeyService.prototype.remove = function (key) {
    var had = Object.prototype.hasOwnProperty.call(this.values, key), old = this.get(key);
    if (had) { delete this.values[key]; this._notify(key, this.get(key), old); }
  };
  ContextKeyService.prototype.subscribe = function (key, fn) {
    var item = { key: key || '*', fn: fn }; this.listeners.push(item);
    var self = this; return function () { var i = self.listeners.indexOf(item); if (i >= 0) self.listeners.splice(i, 1); };
  };
  ContextKeyService.prototype._notify = function (key, value, old) {
    this.listeners.slice().forEach(function (x) { if (x.key === '*' || x.key === key) x.fn(value, old, key); });
    this.children.slice().forEach(function (c) { c._notifyInherited(key, value, old); });
  };
  ContextKeyService.prototype._notifyInherited = function (key, value, old) {
    if (!Object.prototype.hasOwnProperty.call(this.values, key)) {
      this.listeners.slice().forEach(function (x) { if (x.key === '*' || x.key === key) x.fn(value, old, key); });
      this.children.slice().forEach(function (c) { c._notifyInherited(key, value, old); });
    }
  };
  ContextKeyService.prototype.snapshot = function () {
    var out = this.parent ? this.parent.snapshot() : {};
    Object.keys(this.values).forEach(function (k) { out[k] = this.values[k]; }, this); return out;
  };
  ContextKeyService.prototype.setMany = function (map) { Object.keys(map || {}).forEach(function (k) { this.set(k, map[k]); }, this); return this; };
  root.ContextKeyService = ContextKeyService;
  root.ContextKeys = { ContextKeyService: ContextKeyService };
})(typeof window !== 'undefined' ? window : globalThis);
