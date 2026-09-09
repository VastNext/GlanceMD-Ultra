// 运行时快捷键分派单例 —— window.Keybindings 与 window.BindingService 实例集成
//
// 事实源约定（docs/dev/contracts/settings.md §2.6 / §3）：全局 settings.json 的
// `keybindings.activeScheme` + `keybindings.schemes`（按方案隔离的用户绑定）是
// 快捷键的唯一事实源；localStorage 键 `glancemd-ultra-keybindings` /
// `glancemd-ultra-keyboard-scheme` 仅作为 v1.6.3 基线的遗留镜像与退化回退，
// 启动时一次性迁移进设置文档后不再作为来源（迁移标记
// `glancemd-ultra-keybindings-migrated` 防重入）。
//
// 写入路径：任何入口（facade / 设置 UI 直接调用 window.BindingService 实例方法）
// 的覆盖表或方案变更，都把 keybindings 段经 `workspace.settings.set-keybindings`
// 落盘。后端以磁盘最新全局文档为基座做段级 patch（activeScheme 替换、schemes 按
// 方案键合并），因此前端无需维护"写入合并基座"缓存——即使 globalDoc 过期或另一
// 窗口刚改了主题/字号，快捷键写入也绝不回滚其他设置分类。
(function (root) {
  'use strict';

  var KEY = 'glancemd-ultra-keybindings';
  var SCHEME_KEY = 'glancemd-ultra-keyboard-scheme';
  var MIGRATED_KEY = 'glancemd-ultra-keybindings-migrated';
  var DEFAULT_SCHEME = 'ultra.eclipse';

  var GET_GLOBAL_CMD = 'workspace.settings.get-global';
  var SET_KEYBINDINGS_CMD = 'workspace.settings.set-keybindings';

  // 确保全局 ContextKeyService 存在
  if (!root.contextKeys && root.ContextKeyService) {
    root.contextKeys = new root.ContextKeyService();
  }

  // 命令桥接：BindingService 调用 commandId 时转调 window.Commands
  var commandBridge = new Proxy({}, {
    get: function(_, prop) {
      return function(binding) {
        if (root.Commands && typeof root.Commands.run === 'function') {
          return root.Commands.run(prop, binding && binding.args);
        }
      };
    },
    has: function(_, prop) {
      return Boolean(root.Commands && typeof root.Commands.has === 'function' && root.Commands.has(prop));
    }
  });

  // 实例化全局 BindingService
  var platformValue = typeof navigator !== 'undefined' ? String(navigator.platform || navigator.userAgent || '') : '';
  var platformName = /Mac/i.test(platformValue) ? 'macOS' : /Linux|X11/i.test(platformValue) ? 'Linux' : 'Windows';
  var service = root.BindingService && typeof root.BindingService === 'function'
    ? new root.BindingService({
        commands: commandBridge,
        context: root.contextKeys,
        platform: platformName,
        scheme: loadSavedScheme()
      })
    : null;

  function loadSavedScheme() {
    try {
      return localStorage.getItem(SCHEME_KEY) || DEFAULT_SCHEME;
    } catch (e) {
      return DEFAULT_SCHEME;
    }
  }

  function loadOverrides() {
    try {
      return JSON.parse(localStorage.getItem(KEY) || '{}') || {};
    } catch (e) {
      return {};
    }
  }

  /* ── 设置文档桥接（全局 settings.json 为事实源）────────────────────── */

  // 最近一次 get-global 回执的完整设置文档（仅用于装载 keybindings 段与
  // 迁移判定；写入不再依赖它做合并基座——后端以磁盘最新文档为基座）。
  var globalDoc = null;
  // 遗留迁移写入的会话内防重入：写入已发出但未确认成功前不再重试
  // （失败保持不标记，旧 localStorage 数据保留，下次启动重新迁移）。
  var legacyPersistAttempted = false;
  // 内部装载/切换期间抑制回写（避免设置事件回环触发 set-keybindings）。
  var suppressWrite = false;

  function canPersist() {
    return Boolean(root.ipc && typeof root.ipc.postMessage === 'function');
  }

  function send(m) {
    if (root.ipc && typeof root.ipc.postMessage === 'function') {
      root.ipc.postMessage(JSON.stringify(m));
    }
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  // 方案 ID 校验：仅接受运行时已知的内建方案，未知回退默认方案。
  function validSchemeId(id) {
    if (
      id &&
      root.DefaultKeybindings &&
      root.DefaultKeybindings.schemes &&
      Object.prototype.hasOwnProperty.call(root.DefaultKeybindings.schemes, id)
    ) {
      return id;
    }
    return DEFAULT_SCHEME;
  }

  // service 覆盖表（commandId → 记录数组）→ schema v2 Keybinding 记录数组。
  function overridesToRecords(map) {
    var records = [];
    Object.keys(map || {}).forEach(function (id) {
      (map[id] || []).forEach(function (rec) {
        if (!rec || typeof rec !== 'object') return;
        var out = { commandId: rec.commandId || id, sequence: rec.sequence != null ? String(rec.sequence) : '' };
        if (rec.when) out.when = rec.when;
        if (rec.platform && rec.platform !== '*') out.platform = rec.platform;
        if (rec.removed) out.removed = true;
        records.push(out);
      });
    });
    return records;
  }

  // schema v2 方案绑定数组 → service 覆盖表（按 commandId 分组；normalizeOverrides
  // 负责序列规范化与 removed 保留）。
  function schemeRecordsToOverridesMap(records) {
    var map = {};
    (records || []).forEach(function (rec) {
      if (!rec || typeof rec !== 'object' || !rec.commandId) return;
      var id = rec.commandId;
      if (!map[id]) map[id] = [];
      map[id].push(rec);
    });
    return service.normalizeOverrides(map);
  }

  // 构造当前方案的 keybindings 段：只含 activeScheme + 当前方案的用户绑定。
  // 其他方案的绑定由后端按磁盘值保留（段级 patch 按方案键合并），前端缓存
  // 过期也不会把其他方案回滚成旧值。
  function currentKeybindingsSection() {
    var schemeId = service.getScheme();
    var schemes = {};
    schemes[schemeId] = overridesToRecords(service.getOverrides());
    return { activeScheme: schemeId, schemes: schemes };
  }

  // 段级写入：经 workspace.settings.set-keybindings 落盘（后端以磁盘最新
  // 全局文档为基座，只替换 activeScheme 与补丁中出现的方案键）。成功后后端
  // 广播 workspace:settings-changed，前端随后经 get-global 回执装载新文档。
  function persistKeybindings(section) {
    if (!canPersist()) return false;
    send({ command: SET_KEYBINDINGS_CMD, data: JSON.stringify(section) });
    return true;
  }

  // 从设置文档的 keybindings 段装载服务（幂等：与当前一致时不触碰状态；
  // 装载期抑制回写与 localStorage 镜像，防止事件回环、避免在遗留迁移读取前
  // 清掉 localStorage 旧数据）。
  function loadFromSettings(kb) {
    if (!service || !kb || typeof kb !== 'object') return false;
    var schemeId = validSchemeId(kb.activeScheme);
    var schemesMap = kb.schemes && typeof kb.schemes === 'object' ? kb.schemes : {};
    var recordsMap = schemeRecordsToOverridesMap(schemesMap[schemeId] || []);
    var changed = false;
    suppressWrite = true;
    try {
      if (service.getScheme() !== schemeId) {
        service.setScheme(schemeId);
        changed = true;
      }
      var current = service.getOverrides();
      if (JSON.stringify(current) !== JSON.stringify(recordsMap)) {
        // 直接改内存覆盖表（不调 saveOverrides：其会写 localStorage 镜像）
        service.overrides = service.normalizeOverrides(recordsMap);
        changed = true;
      }
    } catch (e) {
      // 设置文档与运行时方案表不一致时保持服务可用（不改写文档）
    } finally {
      suppressWrite = false;
    }
    return changed;
  }

  // 包一层服务实例的持久化方法：任何入口（含设置 UI 直接调用
  // window.BindingService 实例方法）的写入都回写到全局设置文档；原实现
  // （内存状态 + localStorage 镜像）保持不变。
  function wrapServicePersistence(svc) {
    var originalSave = svc.saveOverrides.bind(svc);
    var originalSetScheme = svc.setScheme.bind(svc);

    svc.saveOverrides = function (map) {
      var result = originalSave(map);
      if (!suppressWrite) persistKeybindings(currentKeybindingsSection());
      return result;
    };
    svc.clearOverrides = function () {
      // 直接走原始 saveOverrides（绕开包装，避免双写）
      var result = originalSave({});
      if (!suppressWrite) persistKeybindings(currentKeybindingsSection());
      return result;
    };
    svc.setScheme = function (id) {
      var result = originalSetScheme(id); // 校验 + 切换 + localStorage 镜像
      if (!suppressWrite) {
        // 切到目标方案：装载该方案的用户绑定（分方案独立保存），再回写 activeScheme
        var docKb = globalDoc && globalDoc.keybindings && typeof globalDoc.keybindings === 'object' ? globalDoc.keybindings : {};
        var schemesMap = docKb.schemes && typeof docKb.schemes === 'object' ? docKb.schemes : {};
        suppressWrite = true;
        try {
          svc.saveOverrides(schemeRecordsToOverridesMap(schemesMap[id] || []));
        } catch (e) {
          // 方案绑定装载失败不回写（保持服务原状态）
        } finally {
          suppressWrite = false;
        }
        persistKeybindings(currentKeybindingsSection());
      }
      return result;
    };
    // bind / unbind / reset 内部经 this.saveOverrides 落盘，已被上面包装拦截，无需再包。
  }

  // 旧 localStorage 一次性迁移：设置文档 keybindings 段无用户数据且未迁移过时，
  // 把遗留覆盖表/方案写入设置文档（避免"默认设置覆盖用户旧配置"或反向覆写）。
  //
  // 迁移标记防丢数据：写入确认成功（settings-changed 广播 → get-global 回执
  // → 磁盘已有用户数据 → 本函数再次进入 hasUserData 分支）后才置标记；写入
  // 失败时标记永不置位，遗留 localStorage 数据保留，下次启动重新迁移。
  function maybeMigrateLegacy() {
    if (!canPersist() || !globalDoc) return;
    if (legacyMigrated()) return;
    var kb = globalDoc.keybindings && typeof globalDoc.keybindings === 'object' ? globalDoc.keybindings : {};
    var hasUserData =
      kb.schemes &&
      typeof kb.schemes === 'object' &&
      Object.keys(kb.schemes).some(function (id) {
        return Array.isArray(kb.schemes[id]) && kb.schemes[id].length > 0;
      });
    if (hasUserData) {
      // 设置文档已是事实源（含本会话此前的迁移写入或外部写入）：补置标记，
      // 绝不迁移、绝不覆写
      markLegacyMigrated();
      return;
    }
    if (legacyPersistAttempted) return; // 已发出迁移写入且未确认成功：会话内不重试
    var legacy = readLegacyKeybindings();
    if (!legacy) {
      markLegacyMigrated(); // 无遗留数据：仅标记一次
      return;
    }
    var section = { activeScheme: legacy.scheme, schemes: {} };
    section.schemes[legacy.scheme] = legacy.records;
    legacyPersistAttempted = true;
    // 标记延后：写入确认成功后经 hasUserData 分支补置；失败不标记（可见于
    // 后端 error 事件 → 统一错误提示），旧数据不丢
    persistKeybindings(section);
  }

  function legacyMigrated() {
    try {
      return root.localStorage && root.localStorage.getItem(MIGRATED_KEY) === '1';
    } catch (e) {
      return true;
    }
  }

  function markLegacyMigrated() {
    try {
      if (root.localStorage) root.localStorage.setItem(MIGRATED_KEY, '1');
    } catch (e) {}
  }

  // 读取遗留 localStorage 覆盖表（commandId → 记录数组）与方案，转换为
  // schema v2 记录；无有效记录返回 null。
  function readLegacyKeybindings() {
    var scheme = DEFAULT_SCHEME;
    try {
      var saved = root.localStorage && root.localStorage.getItem(SCHEME_KEY);
      if (saved) scheme = validSchemeId(saved);
    } catch (e) {}
    var raw = null;
    try {
      raw = root.localStorage && root.localStorage.getItem(KEY);
    } catch (e) {}
    var map = null;
    try {
      map = raw ? JSON.parse(raw) : null;
    } catch (e) {
      map = null;
    }
    if (!map || typeof map !== 'object') return null;
    var records = [];
    Object.keys(map).forEach(function (id) {
      var values = Array.isArray(map[id]) ? map[id] : [map[id]];
      values.forEach(function (v) {
        var rec = typeof v === 'string' ? { commandId: id, sequence: v } : Object.assign({}, v, { commandId: id });
        if (rec && rec.commandId) {
          records.push({
            commandId: id,
            sequence: rec.sequence != null ? String(rec.sequence) : '',
            when: rec.when || undefined,
            platform: rec.platform && rec.platform !== '*' ? rec.platform : undefined,
            removed: Boolean(rec.removed)
          });
        }
      });
    });
    if (!records.length) return null;
    return { scheme: scheme, records: records };
  }

  // 订阅设置事件：全局文档（装载 keybindings 段 + 迁移判定 + 外部变化刷新）。
  if (service && root.Workspace && typeof root.Workspace.on === 'function') {
    root.Workspace.on('workspace:settings-global', function (d) {
      if (!d || !d.settings || typeof d.settings !== 'object') return;
      globalDoc = clone(d.settings);
      if (d.settings.keybindings) {
        loadFromSettings(d.settings.keybindings);
      }
      maybeMigrateLegacy();
    });
    root.Workspace.on('workspace:settings-changed', function () {
      send({ command: GET_GLOBAL_CMD });
    });
    // 装载即拉一次全局文档（迁移判定依赖磁盘文档；写入不依赖它）。
    send({ command: GET_GLOBAL_CMD });
  }

  if (service) {
    wrapServicePersistence(service);
  }

  // 统一的全局 Keydown 分派
  function dispatch(e) {
    if (!service) return null;
    // 快捷键录制器激活时不分发
    if (root.contextKeys && root.contextKeys.get('keybindingRecording')) {
      return null;
    }
    // 文本输入控件保护：仅放行显式声明了允许在输入框中触发的命令
    var inInput = e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName);
    if (inInput) {
      if (root.contextKeys) root.contextKeys.set('inputFocus', true);
    } else {
      if (root.contextKeys) root.contextKeys.remove('inputFocus');
    }

    var result = service.dispatch(e);
    if (result && result.status === 'matched') {
      return result.binding ? result.binding.commandId : null;
    }
    return null;
  }

  document.addEventListener('keydown', dispatch);

  // 向后兼容接口，供旧设置页与现有单元测试平滑调用
  var facade = {
    service: service,
    get defaults() {
      var scheme = service ? service.getScheme() : 'ultra.eclipse';
      var rows = (root.DefaultKeybindings && root.DefaultKeybindings.schemes && root.DefaultKeybindings.schemes[scheme]) || [];
      var map = {};
      rows.forEach(function(b) { if (b.commandId && b.sequence) map[b.commandId] = b.sequence; });
      return map;
    },
    load: loadOverrides,
    effective: function() {
      if (!service) return {};
      var bindings = service.getBindings();
      var out = {};
      bindings.forEach(function(b) {
        if (b.commandId && b.sequence) out[b.commandId] = b.sequence;
      });
      return out;
    },
    overrides: function() {
      if (!service) return {};
      var raw = service.getOverrides();
      var out = {};
      Object.keys(raw).forEach(function(id) {
        var list = raw[id];
        if (Array.isArray(list) && list.length && !list[0].removed) {
          out[id] = list[0].sequence;
        }
      });
      return out;
    },
    save: function(map) {
      if (!service) return false;
      service.saveOverrides(map || {});
      try {
        window.dispatchEvent(new CustomEvent('keybindings-changed'));
      } catch (e) {}
      return true;
    },
    clear: function() {
      if (!service) return;
      service.clearOverrides();
      try {
        window.dispatchEvent(new CustomEvent('keybindings-changed'));
      } catch (e) {}
    },
    setScheme: function(id) {
      if (!service) return;
      service.setScheme(id);
      try {
        localStorage.setItem(SCHEME_KEY, id);
      } catch (e) {}
      // 触发全局 scheme 变更事件
      try {
        window.dispatchEvent(new CustomEvent('scheme-changed', { detail: { schemeId: id } }));
      } catch (e) {}
    },
    getScheme: function() {
      return service ? service.getScheme() : 'ultra.eclipse';
    },
    loadFromSettings: loadFromSettings,
    normalize: function(e) {
      return root.KeybindingParser ? root.KeybindingParser.stroke(e) : '';
    },
    dispatch: dispatch
  };

  root.Keybindings = facade;
  if (service) {
    root.BindingServiceInstance = service;
    // 同时把已构造的单例赋值给全局 BindingService 供 UI 模块直接消费
    root.BindingService = service;
  }
})(typeof window !== 'undefined' ? window : globalThis);
