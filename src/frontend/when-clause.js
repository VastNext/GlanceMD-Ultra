(function (root) {
  'use strict';
  function tokenize(s) { var re = /\s*(==|!=|&&|\|\||!|\(|\)|[A-Za-z_$][\w.$-]*|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\d+(?:\.\d+)?)\s*/g, a = [], m; while ((m = re.exec(s || ''))) a.push(m[1]); return a; }
  function parse(input) {
    var t = tokenize(input), i = 0;
    function primary() {
      if (t[i] === '(') { i++; var x = or(); if (t[i] !== ')') throw Error('Expected )'); i++; return x; }
      var name = t[i++]; if (!name) throw Error('Expected key');
      if (t[i] === '==' || t[i] === '!=') { var op = t[i++], value = t[i++]; if (value == null) throw Error('Expected value'); return { type: 'compare', key: name, op: op, value: decode(value) }; }
      return { type: 'truthy', key: name };
    }
    function unary() { if (t[i] === '!') { i++; return { type: 'not', value: unary() }; } return primary(); }
    function and() { var x = unary(); while (t[i] === '&&') { i++; x = { type: 'and', left: x, right: unary() }; } return x; }
    function or() { var x = and(); while (t[i] === '||') { i++; x = { type: 'or', left: x, right: and() }; } return x; }
    if (!t.length) return null; var ast = or(); if (i !== t.length) throw Error('Unexpected token ' + t[i]); return ast;
  }
  function decode(x) { if ((x[0] === '"' && x[x.length - 1] === '"') || (x[0] === "'" && x[x.length - 1] === "'")) return x.slice(1, -1); if (x === 'true') return true; if (x === 'false') return false; if (x === 'null') return null; return /^\d/.test(x) ? Number(x) : x; }
  function evaluate(ast, context) { if (!ast) return true; if (ast.type === 'truthy') return !!context.get(ast.key); if (ast.type === 'not') return !evaluate(ast.value, context); if (ast.type === 'and') return evaluate(ast.left, context) && evaluate(ast.right, context); if (ast.type === 'or') return evaluate(ast.left, context) || evaluate(ast.right, context); var actual = context.get(ast.key); return ast.op === '==' ? actual === ast.value : actual !== ast.value; }
  function WhenClause(s) { this.source = s || ''; this.ast = parse(this.source); }
  WhenClause.prototype.evaluate = function (context) { return evaluate(this.ast, context); };
  root.WhenClause = WhenClause; root.When = { tokenize: tokenize, parse: parse, evaluate: evaluate, WhenClause: WhenClause };
})(typeof window !== 'undefined' ? window : globalThis);
