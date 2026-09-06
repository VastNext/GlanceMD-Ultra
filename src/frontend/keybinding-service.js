(function (root) {
  'use strict';

  var STORAGE_KEY = 'glancemd-ultra-keybindings';
  var SCHEME_STORAGE_KEY = 'glancemd-ultra-keyboard-scheme';

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function canonicalRecord(input, source) {
    input = input || {};
    var commandId = input.commandId || input.id || '';
    var sequence = input.sequence || input.key || '';
    return {
      commandId: commandId,
      sequence: root.KeybindingParser ? root.KeybindingParser.format(sequence) : String(sequence || ''),
      when: input.when || '',
      platform: input.platform || '*',
      source: input.source || source || 'default',
      removed: Boolean(input.removed)
    };
  }

  function BindingService(options) {
    options = options || {};
    this.commands = options.commands || {};
    this.context = options.context || new root.ContextKeyService();
    this.platform = options.platform || 'Windows';
    this.timeout = options.timeout == null ? 1000 : options.timeout;
    this.schemes = options.schemes || (root.DefaultKeybindings && root.DefaultKeybindings.schemes) || {};
    this.schemeId = options.scheme || (root.DefaultKeybindings && root.DefaultKeybindings.defaultScheme) || 'ultra.eclipse';
    this.overrides = {};
    this.pending = null;
    this.loadOverrides();
    if (!this.schemes[this.schemeId]) this.schemeId = 'ultra.eclipse';
  }

  BindingService.prototype.getSchemes = function () {
    var self = this;
    return Object.keys(this.schemes).map(function (id) {
      return { id: id, label: id === 'ultra.eclipse' ? 'Ultra Eclipse' : id === 'ultra.vscode' ? 'VS Code' : id };
    });
  };
  BindingService.prototype.getActiveSchemeId = function () { return this.schemeId; };
  BindingService.prototype.setScheme = function (id) {
    if (!this.schemes[id]) throw Error('Unknown keybinding scheme: ' + id);
    this.schemeId = id; this.cancelChord(); this.persistScheme(); return id;
  };
  BindingService.prototype.getScheme = function () { return this.getActiveSchemeId(); };

  BindingService.prototype.getOverrides = function () { return clone(this.overrides); };
  BindingService.prototype.loadOverrides = function () {
    var raw = null;
    try { raw = root.localStorage && root.localStorage.getItem(STORAGE_KEY); } catch (e) {}
    try { this.overrides = raw ? this.normalizeOverrides(JSON.parse(raw)) : {}; } catch (e2) { this.overrides = {}; }
    return this.getOverrides();
  };
  BindingService.prototype.normalizeOverrides = function (map) {
    var out = {};
    Object.keys(map || {}).forEach(function (id) {
      var values = Array.isArray(map[id]) ? map[id] : [map[id]];
      out[id] = values.map(function (value) {
        return canonicalRecord(typeof value === 'string' ? { commandId: id, sequence: value } : Object.assign({}, value, { commandId: id }), 'user');
      });
    });
    return out;
  };
  BindingService.prototype.saveOverrides = function (map) {
    this.overrides = this.normalizeOverrides(map || {});
    try { if (root.localStorage) root.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.overrides)); } catch (e) {}
    return this.getOverrides();
  };
  BindingService.prototype.setOverrides = function (map) {
    return this.saveOverrides(map);
  };
  BindingService.prototype.clearOverrides = function () { return this.saveOverrides({}); };
  BindingService.prototype.reset = function (commandId, sequence) {
    if (!commandId) return this;
    var map = this.getOverrides();
    if (!sequence) delete map[commandId];
    else if (map[commandId]) map[commandId] = map[commandId].filter(function (binding) { return binding.sequence !== sequence; });
    this.saveOverrides(map);
    return this;
  };
  BindingService.prototype.persistScheme = function () {
    try { if (root.localStorage) root.localStorage.setItem(SCHEME_STORAGE_KEY, this.schemeId); } catch (e) {}
  };

  BindingService.prototype.bind = function (commandId, sequence, options) {
    options = options || {};
    var map = this.getOverrides();
    if (!map[commandId]) map[commandId] = [];
    map[commandId].push(canonicalRecord({ commandId: commandId, sequence: sequence, when: options.when, platform: options.platform }, 'user'));
    this.saveOverrides(map); return this;
  };
  BindingService.prototype.unbind = function (commandId, sequence) {
    var map = this.getOverrides();
    if (sequence) {
      map[commandId] = (map[commandId] || []).map(function (b) { return b.sequence === sequence ? Object.assign({}, b, { removed: true, sequence: '' }) : b; });
    } else {
      map[commandId] = [canonicalRecord({ commandId: commandId, sequence: '', removed: true }, 'user')];
    }
    this.saveOverrides(map); return this;
  };

  BindingService.prototype.getBindings = function () {
    var rows = (this.schemes[this.schemeId] || []).map(function (b) { return canonicalRecord(b, 'default'); });
    var overrides = this.overrides;
    Object.keys(overrides).forEach(function (id) {
      rows = rows.filter(function (b) { return b.commandId !== id; });
      overrides[id].forEach(function (b) { if (!b.removed && b.sequence) rows.push(canonicalRecord(b, 'user')); });
    });
    return rows;
  };

  BindingService.prototype.active = function (binding) {
    return (binding.platform === '*' || binding.platform === this.platform) &&
      (!binding.when || binding.when === 'global' || new root.WhenClause(binding.when).evaluate(this.context));
  };
  BindingService.prototype.resolve = function (sequence) {
    var seq = root.KeybindingParser.parse(sequence), found = [], partial = false;
    this.getBindings().forEach(function (binding) {
      if (!this.active(binding)) return;
      var keys = root.KeybindingParser.parse(binding.sequence);
      if (keys.length === seq.length && keys.every(function (x, i) { return x === seq[i]; })) found.push(binding);
      else if (keys.length > seq.length && seq.every(function (x, i) { return x === keys[i]; })) partial = true;
    }, this);
    return { bindings: found, partial: partial };
  };
  BindingService.prototype.cancelChord = function () { if (this.pending && this.pending.timer) clearTimeout(this.pending.timer); this.pending = null; };
  BindingService.prototype.handleKey = function (event) {
    var stroke = root.KeybindingParser.stroke(event), self = this;
    if (stroke === 'Escape' && this.pending) { this.cancelChord(); return { status: 'cancelled' }; }
    var sequence = this.pending ? this.pending.sequence.concat(stroke) : [stroke];
    var result = this.resolve(sequence);
    if (result.bindings.length) { this.cancelChord(); return { status: 'matched', binding: result.bindings[0], bindings: result.bindings }; }
    if (result.partial) { this.cancelChord(); this.pending = { sequence: sequence, timer: setTimeout(function () { self.cancelChord(); }, this.timeout) }; return { status: 'pending', sequence: sequence.slice() }; }
    this.cancelChord(); return { status: 'unmatched', sequence: sequence };
  };
  BindingService.prototype.execute = function (commandId, binding) {
    var fn = typeof this.commands[commandId] === 'function' ? this.commands[commandId] : null;
    return fn ? fn(binding) : undefined;
  };
  BindingService.prototype.dispatch = function (event) {
    var result = this.handleKey(event);
    if (result.status === 'matched') { if (event.preventDefault) event.preventDefault(); result.value = this.execute(result.binding.commandId, result.binding); }
    return result;
  };
  BindingService.prototype.scanConflicts = function () {
    var seen = {}, out = [];
    this.getBindings().forEach(function (b) {
      var key = b.sequence + '|' + b.when + '|' + b.platform;
      if (seen[key]) out.push({ sequence: b.sequence, commands: [seen[key], b.commandId], when: b.when, platform: b.platform });
      else seen[key] = b.commandId;
    });
    return out;
  };

  root.KeybindingService = BindingService;
  root.BindingService = BindingService;
})(typeof window !== 'undefined' ? window : globalThis);
