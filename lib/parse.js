/***********************************************************************

  A JavaScript tokenizer / parser / beautifier / compressor.
  https://github.com/mishoo/UglifyJS

  -------------------------------- (C) ---------------------------------

                           Author: Mihai Bazon
                         <mihai.bazon@gmail.com>
                       http://mihai.bazon.net/blog

  Distributed under the BSD license:

    Copyright 2012 (c) Mihai Bazon <mihai.bazon@gmail.com>
    Parser based on parse-js (http://marijn.haverbeke.nl/parse-js/).

    Redistribution and use in source and binary forms, with or without
    modification, are permitted provided that the following conditions
    are met:

        * Redistributions of source code must retain the above
          copyright notice, this list of conditions and the following
          disclaimer.

        * Redistributions in binary form must reproduce the above
          copyright notice, this list of conditions and the following
          disclaimer in the documentation and/or other materials
          provided with the distribution.

    THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDER “AS IS” AND ANY
    EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
    IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR
    PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER BE
    LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY,
    OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
    PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
    PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
    THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR
    TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF
    THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF
    SUCH DAMAGE.

 ***********************************************************************/

"use strict";

var KEYWORDS = "break case catch const continue debugger default delete do else finally for function if in instanceof let new return switch throw try typeof var void while with";
var KEYWORDS_ATOM = "false null true";
var RESERVED_WORDS = [
    "await abstract boolean byte char class double enum export extends final float goto implements import int interface long native package private protected public short static super synchronized this throws transient volatile yield",
    KEYWORDS_ATOM,
    KEYWORDS,
].join(" ");
var KEYWORDS_BEFORE_EXPRESSION = "return new delete throw else case";

KEYWORDS = makePredicate(KEYWORDS);
RESERVED_WORDS = makePredicate(RESERVED_WORDS);
KEYWORDS_BEFORE_EXPRESSION = makePredicate(KEYWORDS_BEFORE_EXPRESSION);
KEYWORDS_ATOM = makePredicate(KEYWORDS_ATOM);

var RE_BIN_NUMBER = /^0b([01]+)$/i;
var RE_HEX_NUMBER = /^0x([0-9a-f]+)$/i;
var RE_OCT_NUMBER = /^0o?([0-7]+)$/i;

var OPERATORS = makePredicate([
    "in",
    "instanceof",
    "typeof",
    "new",
    "void",
    "delete",
    "++",
    "--",
    "+",
    "-",
    "!",
    "~",
    "&",
    "|",
    "^",
    "*",
    "/",
    "%",
    "**",
    ">>",
    "<<",
    ">>>",
    "<",
    ">",
    "<=",
    ">=",
    "==",
    "===",
    "!=",
    "!==",
    "?",
    "=",
    "+=",
    "-=",
    "/=",
    "*=",
    "%=",
    ">>=",
    "<<=",
    ">>>=",
    "|=",
    "^=",
    "&=",
    "&&",
    "||"
]);

var NEWLINE_CHARS = "\n\r\u2028\u2029";
var OPERATOR_CHARS = "+-*&%=<>!?|~^";
var PUNC_BEFORE_EXPRESSION = "[{(,;:";
var PUNC_CHARS = PUNC_BEFORE_EXPRESSION + ")}]";
var WHITESPACE_CHARS = NEWLINE_CHARS + " \u00a0\t\f\u000b\u200b\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u202f\u205f\u3000\uFEFF";
var NON_IDENTIFIER_CHARS = makePredicate(characters("./'\"" + OPERATOR_CHARS + PUNC_CHARS + WHITESPACE_CHARS));

NEWLINE_CHARS = makePredicate(characters(NEWLINE_CHARS));
OPERATOR_CHARS = makePredicate(characters(OPERATOR_CHARS));
PUNC_BEFORE_EXPRESSION = makePredicate(characters(PUNC_BEFORE_EXPRESSION));
PUNC_CHARS = makePredicate(characters(PUNC_CHARS));
WHITESPACE_CHARS = makePredicate(characters(WHITESPACE_CHARS));

/* -----[ Tokenizer ]----- */

function is_surrogate_pair_head(code) {
    return code >= 0xd800 && code <= 0xdbff;
}

function is_surrogate_pair_tail(code) {
    return code >= 0xdc00 && code <= 0xdfff;
}

function is_digit(code) {
    return code >= 48 && code <= 57;
}

function is_identifier_char(ch) {
    return !NON_IDENTIFIER_CHARS[ch];
}

function is_identifier_string(str) {
    return /^[a-z_$][a-z0-9_$]*$/i.test(str);
}

function parse_js_number(num) {
    var match;
    if (match = RE_BIN_NUMBER.exec(num)) return parseInt(match[1], 2);
    if (match = RE_HEX_NUMBER.exec(num)) return parseInt(match[1], 16);
    if (match = RE_OCT_NUMBER.exec(num)) return parseInt(match[1], 8);
    var val = parseFloat(num);
    if (val == num) return val;
}

function JS_Parse_Error(message, filename, line, col, pos) {
    this.message = message;
    this.filename = filename;
    this.line = line;
    this.col = col;
    this.pos = pos;
}
JS_Parse_Error.prototype = Object.create(Error.prototype);
JS_Parse_Error.prototype.constructor = JS_Parse_Error;
JS_Parse_Error.prototype.name = "SyntaxError";
configure_error_stack(JS_Parse_Error);

function js_error(message, filename, line, col, pos) {
    throw new JS_Parse_Error(message, filename, line, col, pos);
}

function is_token(token, type, val) {
    return token.type == type && (val == null || token.value == val);
}

var EX_EOF = {};

function tokenizer($TEXT, filename, html5_comments, shebang) {

    var S = {
        text            : $TEXT,
        filename        : filename,
        pos             : 0,
        tokpos          : 0,
        line            : 1,
        tokline         : 0,
        col             : 0,
        tokcol          : 0,
        newline_before  : false,
        regex_allowed   : false,
        comments_before : [],
        directives      : {},
        directive_stack : []
    };
    var prev_was_dot = false;

    function peek() {
        return S.text.charAt(S.pos);
    }

    function next(signal_eof, in_string) {
        var ch = S.text.charAt(S.pos++);
        if (signal_eof && !ch)
            throw EX_EOF;
        if (NEWLINE_CHARS[ch]) {
            S.col = 0;
            S.line++;
            if (!in_string) S.newline_before = true;
            if (ch == "\r" && peek() == "\n") {
                // treat `\r\n` as `\n`
                S.pos++;
                ch = "\n";
            }
        } else {
            S.col++;
        }
        return ch;
    }

    function forward(i) {
        while (i-- > 0) next();
    }

    function looking_at(str) {
        return S.text.substr(S.pos, str.length) == str;
    }

    function find_eol() {
        var text = S.text;
        for (var i = S.pos; i < S.text.length; ++i) {
            if (NEWLINE_CHARS[text[i]]) return i;
        }
        return -1;
    }

    function find(what, signal_eof) {
        var pos = S.text.indexOf(what, S.pos);
        if (signal_eof && pos == -1) throw EX_EOF;
        return pos;
    }

    function start_token() {
        S.tokline = S.line;
        S.tokcol = S.col;
        S.tokpos = S.pos;
    }

    function token(type, value, is_comment) {
        S.regex_allowed = type == "operator" && !UNARY_POSTFIX[value]
            || type == "keyword" && KEYWORDS_BEFORE_EXPRESSION[value]
            || type == "punc" && PUNC_BEFORE_EXPRESSION[value];
        if (type == "punc" && value == ".") prev_was_dot = true;
        else if (!is_comment) prev_was_dot = false;
        var ret = {
            type    : type,
            value   : value,
            line    : S.tokline,
            col     : S.tokcol,
            pos     : S.tokpos,
            endline : S.line,
            endcol  : S.col,
            endpos  : S.pos,
            nlb     : S.newline_before,
            file    : filename
        };
        if (/^(?:num|string|regexp)$/i.test(type)) {
            ret.raw = $TEXT.substring(ret.pos, ret.endpos);
        }
        if (!is_comment) {
            ret.comments_before = S.comments_before;
            ret.comments_after = S.comments_before = [];
        }
        S.newline_before = false;
        return new AST_Token(ret);
    }

    function skip_whitespace() {
        while (WHITESPACE_CHARS[peek()])
            next();
    }

    function read_while(pred) {
        var ret = "", ch;
        while ((ch = peek()) && pred(ch)) ret += next();
        return ret;
    }

    function parse_error(err) {
        js_error(err, filename, S.tokline, S.tokcol, S.tokpos);
    }

    function read_num(prefix) {
        var has_e = false, after_e = false, has_x = false, has_dot = prefix == ".";
        var num = read_while(function(ch) {
            var code = ch.charCodeAt(0);
            switch (code) {
              case 120: case 88: // xX
                return has_x ? false : (has_x = true);
              case 101: case 69: // eE
                return has_x ? true : has_e ? false : (has_e = after_e = true);
              case 43: case 45: // +-
                return after_e;
              case (after_e = false, 46): // .
                return (!has_dot && !has_x && !has_e) ? (has_dot = true) : false;
            }
            return is_digit(code) || /[_0-9a-fo]/i.test(ch);
        });
        if (prefix) num = prefix + num;
        if (/^0[0-7_]+$/.test(num)) {
            if (next_token.has_directive("use strict")) parse_error("Legacy octal literals are not allowed in strict mode");
        } else {
            num = num.replace(has_x ? /([1-9a-f]|.0)_(?=[0-9a-f])/gi : /([1-9]|.0)_(?=[0-9])/gi, "$1");
        }
        var valid = parse_js_number(num);
        if (isNaN(valid)) parse_error("Invalid syntax: " + num);
        if (has_dot || has_e || peek() != "n") return token("num", valid);
        return token("bigint", num.toLowerCase() + next());
    }

    function read_escaped_char(in_string) {
        var ch = next(true, in_string);
        switch (ch.charCodeAt(0)) {
          case 110: return "\n";
          case 114: return "\r";
          case 116: return "\t";
          case 98:  return "\b";
          case 118: return "\u000b";                            // \v
          case 102: return "\f";
          case 120: return String.fromCharCode(hex_bytes(2));   // \x
          case 117:                                             // \u
            if (peek() != "{") return String.fromCharCode(hex_bytes(4));
            next();
            var num = 0;
            do {
                var digit = parseInt(next(true), 16);
                if (isNaN(digit)) parse_error("Invalid hex-character pattern in string");
                num = num * 16 + digit;
            } while (peek() != "}");
            next();
            if (num < 0x10000) return String.fromCharCode(num);
            if (num > 0x10ffff) parse_error("Invalid character code: " + num);
            return String.fromCharCode((num >> 10) + 0xd7c0) + String.fromCharCode((num & 0x03ff) + 0xdc00);
          case 13:                                              // \r
            // DOS newline
            if (peek() == "\n") next(true, in_string);
          case 10:  return "";                                  // \n
        }
        if (ch >= "0" && ch <= "7")
            return read_octal_escape_sequence(ch);
        return ch;
    }

    function read_octal_escape_sequence(ch) {
        // Read
        var p = peek();
        if (p >= "0" && p <= "7") {
            ch += next(true);
            if (ch[0] <= "3" && (p = peek()) >= "0" && p <= "7")
                ch += next(true);
        }

        // Parse
        if (ch === "0") return "\0";
        if (ch.length > 0 && next_token.has_directive("use strict"))
            parse_error("Legacy octal escape sequences are not allowed in strict mode");
        return String.fromCharCode(parseInt(ch, 8));
    }

    function hex_bytes(n) {
        var num = 0;
        for (; n > 0; --n) {
            var digit = parseInt(next(true), 16);
            if (isNaN(digit))
                parse_error("Invalid hex-character pattern in string");
            num = (num << 4) | digit;
        }
        return num;
    }

    var read_string = with_eof_error("Unterminated string constant", function(quote_char) {
        var quote = next(), ret = "";
        for (;;) {
            var ch = next(true, true);
            if (ch == "\\") ch = read_escaped_char(true);
            else if (NEWLINE_CHARS[ch]) parse_error("Unterminated string constant");
            else if (ch == quote) break;
            ret += ch;
        }
        var tok = token("string", ret);
        tok.quote = quote_char;
        return tok;
    });

    function skip_line_comment(type) {
        var regex_allowed = S.regex_allowed;
        var i = find_eol(), ret;
        if (i == -1) {
            ret = S.text.substr(S.pos);
            S.pos = S.text.length;
        } else {
            ret = S.text.substring(S.pos, i);
            S.pos = i;
        }
        S.col = S.tokcol + (S.pos - S.tokpos);
        S.comments_before.push(token(type, ret, true));
        S.regex_allowed = regex_allowed;
        return next_token;
    }

    var skip_multiline_comment = with_eof_error("Unterminated multiline comment", function() {
        var regex_allowed = S.regex_allowed;
        var i = find("*/", true);
        var text = S.text.substring(S.pos, i).replace(/\r\n|\r|\u2028|\u2029/g, "\n");
        // update stream position
        forward(text.length /* doesn't count \r\n as 2 char while S.pos - i does */ + 2);
        S.comments_before.push(token("comment2", text, true));
        S.regex_allowed = regex_allowed;
        return next_token;
    });

    function read_name() {
        var backslash = false, name = "", ch, escaped = false, hex;
        while (ch = peek()) {
            if (!backslash) {
                if (ch == "\\") escaped = backslash = true, next();
                else if (is_identifier_char(ch)) name += next();
                else break;
            } else {
                if (ch != "u") parse_error("Expecting UnicodeEscapeSequence -- uXXXX");
                ch = read_escaped_char();
                if (!is_identifier_char(ch)) parse_error("Unicode char: " + ch.charCodeAt(0) + " is not valid in identifier");
                name += ch;
                backslash = false;
            }
        }
        if (KEYWORDS[name] && escaped) {
            hex = name.charCodeAt(0).toString(16).toUpperCase();
            name = "\\u" + "0000".substr(hex.length) + hex + name.slice(1);
        }
        return name;
    }

    var read_regexp = with_eof_error("Unterminated regular expression", function(source) {
        var prev_backslash = false, ch, in_class = false;
        while ((ch = next(true))) if (NEWLINE_CHARS[ch]) {
            parse_error("Unexpected line terminator");
        } else if (prev_backslash) {
            source += "\\" + ch;
            prev_backslash = false;
        } else if (ch == "[") {
            in_class = true;
            source += ch;
        } else if (ch == "]" && in_class) {
            in_class = false;
            source += ch;
        } else if (ch == "/" && !in_class) {
            break;
        } else if (ch == "\\") {
            prev_backslash = true;
        } else {
            source += ch;
        }
        var mods = read_name();
        try {
            var regexp = new RegExp(source, mods);
            regexp.raw_source = source;
            return token("regexp", regexp);
        } catch (e) {
            parse_error(e.message);
        }
    });

    function read_operator(prefix) {
        function grow(op) {
            if (!peek()) return op;
            var bigger = op + peek();
            if (OPERATORS[bigger]) {
                next();
                return grow(bigger);
            } else {
                return op;
            }
        }
        return token("operator", grow(prefix || next()));
    }

    function handle_slash() {
        next();
        switch (peek()) {
          case "/":
            next();
            return skip_line_comment("comment1");
          case "*":
            next();
            return skip_multiline_comment();
        }
        return S.regex_allowed ? read_regexp("") : read_operator("/");
    }

    function handle_dot() {
        next();
        var ch = peek();
        if (ch == ".") {
            var op = ".";
            do {
                op += ".";
                next();
            } while (peek() == ".");
            return token("operator", op);
        }
        return is_digit(ch.charCodeAt(0)) ? read_num(".") : token("punc", ".");
    }

    function read_word() {
        var word = read_name();
        if (prev_was_dot) return token("name", word);
        return KEYWORDS_ATOM[word] ? token("atom", word)
            : !KEYWORDS[word] ? token("name", word)
            : OPERATORS[word] ? token("operator", word)
            : token("keyword", word);
    }

    function with_eof_error(eof_error, cont) {
        return function(x) {
            try {
                return cont(x);
            } catch (ex) {
                if (ex === EX_EOF) parse_error(eof_error);
                else throw ex;
            }
        };
    }

    function next_token(force_regexp) {
        if (force_regexp != null)
            return read_regexp(force_regexp);
        if (shebang && S.pos == 0 && looking_at("#!")) {
            start_token();
            forward(2);
            skip_line_comment("comment5");
        }
        for (;;) {
            skip_whitespace();
            start_token();
            if (html5_comments) {
                if (looking_at("<!--")) {
                    forward(4);
                    skip_line_comment("comment3");
                    continue;
                }
                if (looking_at("-->") && S.newline_before) {
                    forward(3);
                    skip_line_comment("comment4");
                    continue;
                }
            }
            var ch = peek();
            if (!ch) return token("eof");
            var code = ch.charCodeAt(0);
            switch (code) {
              case 34: case 39: return read_string(ch);
              case 46: return handle_dot();
              case 47:
                var tok = handle_slash();
                if (tok === next_token) continue;
                return tok;
            }
            if (is_digit(code)) return read_num();
            if (PUNC_CHARS[ch]) return token("punc", next());
            if (looking_at("=>")) return token("punc", next() + next());
            if (OPERATOR_CHARS[ch]) return read_operator();
            if (code == 92 || !NON_IDENTIFIER_CHARS[ch]) return read_word();
            break;
        }
        parse_error("Unexpected character '" + ch + "'");
    }

    next_token.context = function(nc) {
        if (nc) S = nc;
        return S;
    };

    next_token.add_directive = function(directive) {
        S.directive_stack[S.directive_stack.length - 1].push(directive);
        if (S.directives[directive]) S.directives[directive]++;
        else S.directives[directive] = 1;
    }

    next_token.push_directives_stack = function() {
        S.directive_stack.push([]);
    }

    next_token.pop_directives_stack = function() {
        var directives = S.directive_stack.pop();
        for (var i = directives.length; --i >= 0;) {
            S.directives[directives[i]]--;
        }
    }

    next_token.has_directive = function(directive) {
        return S.directives[directive] > 0;
    }

    return next_token;
}

/* -----[ Parser (constants) ]----- */

var UNARY_PREFIX = makePredicate("typeof void delete -- ++ ! ~ - +");

var UNARY_POSTFIX = makePredicate("-- ++");

var ASSIGNMENT = makePredicate("= += -= /= *= %= >>= <<= >>>= |= ^= &=");

var PRECEDENCE = function(a, ret) {
    for (var i = 0; i < a.length;) {
        var b = a[i++];
        for (var j = 0; j < b.length; j++) {
            ret[b[j]] = i;
        }
    }
    return ret;
}([
    ["||"],
    ["&&"],
    ["|"],
    ["^"],
    ["&"],
    ["==", "===", "!=", "!=="],
    ["<", ">", "<=", ">=", "in", "instanceof"],
    [">>", "<<", ">>>"],
    ["+", "-"],
    ["*", "/", "%"],
    ["**"],
], {});

var ATOMIC_START_TOKEN = makePredicate("atom bigint num regexp string");

/* -----[ Parser ]----- */

function parse($TEXT, options) {
    options = defaults(options, {
        bare_returns   : false,
        expression     : false,
        filename       : null,
        html5_comments : true,
        shebang        : true,
        strict         : false,
        toplevel       : null,
    }, true);

    var S = {
        input         : typeof $TEXT == "string"
                        ? tokenizer($TEXT, options.filename, options.html5_comments, options.shebang)
                        : $TEXT,
        in_async      : false,
        in_directives : true,
        in_funarg     : -1,
        in_function   : 0,
        in_loop       : 0,
        labels        : [],
        peeked        : null,
        prev          : null,
        token         : null,
    };

    S.token = next();

    function is(type, value) {
        return is_token(S.token, type, value);
    }

    function peek() {
        return S.peeked || (S.peeked = S.input());
    }

    function next() {
        S.prev = S.token;
        if (S.peeked) {
            S.token = S.peeked;
            S.peeked = null;
        } else {
            S.token = S.input();
        }
        S.in_directives = S.in_directives && (
            S.token.type == "string" || is("punc", ";")
        );
        return S.token;
    }

    function prev() {
        return S.prev;
    }

    function croak(msg, line, col, pos) {
        var ctx = S.input.context();
        js_error(msg,
                 ctx.filename,
                 line != null ? line : ctx.tokline,
                 col != null ? col : ctx.tokcol,
                 pos != null ? pos : ctx.tokpos);
    }

    function token_error(token, msg) {
        croak(msg, token.line, token.col);
    }

    function token_to_string(type, value) {
        return type + (value === undefined ? "" : " «" + value + "»");
    }

    function unexpected(token) {
        if (token == null) token = S.token;
        token_error(token, "Unexpected token: " + token_to_string(token.type, token.value));
    }

    function expect_token(type, val) {
        if (is(type, val)) return next();
        token_error(S.token, "Unexpected token: " + token_to_string(S.token.type, S.token.value) + ", expected: " + token_to_string(type, val));
    }

    function expect(punc) {
        return expect_token("punc", punc);
    }

    function has_newline_before(token) {
        return token.nlb || !all(token.comments_before, function(comment) {
            return !comment.nlb;
        });
    }

    function can_insert_semicolon() {
        return !options.strict
            && (is("eof") || is("punc", "}") || has_newline_before(S.token));
    }

    function semicolon(optional) {
        if (is("punc", ";")) next();
        else if (!optional && !can_insert_semicolon()) expect(";");
    }

    function parenthesised() {
        expect("(");
        var exp = expression();
        expect(")");
        return exp;
    }

    function embed_tokens(parser) {
        return function() {
            var start = S.token;
            var expr = parser.apply(null, arguments);
            var end = prev();
            expr.start = start;
            expr.end = end;
            return expr;
        };
    }

    function handle_regexp() {
        if (is("operator", "/") || is("operator", "/=")) {
            S.peeked = null;
            S.token = S.input(S.token.value.substr(1)); // force regexp
        }
    }

    var statement = embed_tokens(function() {
        handle_regexp();
        switch (S.token.type) {
          case "string":
            var dir = S.in_directives;
            var body = expression();
            if (dir) {
                if (body instanceof AST_String) {
                    var value = body.start.raw.slice(1, -1);
                    S.input.add_directive(value);
                    body.value = value;
                } else {
                    S.in_directives = dir = false;
                }
            }
            semicolon();
            return dir ? new AST_Directive(body) : new AST_SimpleStatement({ body: body });
          case "num":
          case "bigint":
          case "regexp":
          case "operator":
          case "atom":
            return simple_statement();

          case "name":
            switch (S.token.value) {
              case "async":
                if (is_token(peek(), "keyword", "function")) {
                    next();
                    next();
                    return function_(AST_AsyncDefun);
                }
                break;
              case "await":
                if (S.in_async) return simple_statement();
                break;
            }
            return is_token(peek(), "punc", ":")
                ? labeled_statement()
                : simple_statement();

          case "punc":
            switch (S.token.value) {
              case "{":
                return new AST_BlockStatement({
                    start : S.token,
                    body  : block_(),
                    end   : prev()
                });
              case "[":
              case "(":
                return simple_statement();
              case ";":
                S.in_directives = false;
                next();
                return new AST_EmptyStatement();
              default:
                unexpected();
            }

          case "keyword":
            switch (S.token.value) {
              case "break":
                next();
                return break_cont(AST_Break);

              case "const":
                next();
                var node = const_();
                semicolon();
                return node;

              case "continue":
                next();
                return break_cont(AST_Continue);

              case "debugger":
                next();
                semicolon();
                return new AST_Debugger();

              case "do":
                next();
                var body = in_loop(statement);
                expect_token("keyword", "while");
                var condition = parenthesised();
                semicolon(true);
                return new AST_Do({
                    body      : body,
                    condition : condition
                });

              case "while":
                next();
                return new AST_While({
                    condition : parenthesised(),
                    body      : in_loop(statement)
                });

              case "for":
                next();
                return for_();

              case "function":
                next();
                return function_(AST_Defun);

              case "if":
                next();
                return if_();

              case "let":
                next();
                var node = let_();
                semicolon();
                return node;

              case "return":
                if (S.in_function == 0 && !options.bare_returns)
                    croak("'return' outside of function");
                next();
                var value = null;
                if (is("punc", ";")) {
                    next();
                } else if (!can_insert_semicolon()) {
                    value = expression();
                    semicolon();
                }
                return new AST_Return({
                    value: value
                });

              case "switch":
                next();
                return new AST_Switch({
                    expression : parenthesised(),
                    body       : in_loop(switch_body_)
                });

              case "throw":
                next();
                if (has_newline_before(S.token))
                    croak("Illegal newline after 'throw'");
                var value = expression();
                semicolon();
                return new AST_Throw({
                    value: value
                });

              case "try":
                next();
                return try_();

              case "var":
                next();
                var node = var_();
                semicolon();
                return node;

              case "with":
                if (S.input.has_directive("use strict")) {
                    croak("Strict mode may not include a with statement");
                }
                next();
                return new AST_With({
                    expression : parenthesised(),
                    body       : statement()
                });
            }
        }
        unexpected();
    });

    function labeled_statement() {
        var label = as_symbol(AST_Label);
        if (!all(S.labels, function(l) {
            return l.name != label.name;
        })) {
            // ECMA-262, 12.12: An ECMAScript program is considered
            // syntactically incorrect if it contains a
            // LabelledStatement that is enclosed by a
            // LabelledStatement with the same Identifier as label.
            croak("Label " + label.name + " defined twice");
        }
        expect(":");
        S.labels.push(label);
        var stat = statement();
        S.labels.pop();
        if (!(stat instanceof AST_IterationStatement)) {
            // check for `continue` that refers to this label.
            // those should be reported as syntax errors.
            // https://github.com/mishoo/UglifyJS/issues/287
            label.references.forEach(function(ref) {
                if (ref instanceof AST_Continue) {
                    token_error(ref.label.start, "Continue label `" + label.name + "` must refer to IterationStatement");
                }
            });
        }
        return new AST_LabeledStatement({ body: stat, label: label });
    }

    function simple_statement() {
        var body = expression();
        semicolon();
        return new AST_SimpleStatement({ body: body });
    }

    function break_cont(type) {
        var label = null, ldef;
        if (!can_insert_semicolon()) {
            label = as_symbol(AST_LabelRef, true);
        }
        if (label != null) {
            ldef = find_if(function(l) {
                return l.name == label.name;
            }, S.labels);
            if (!ldef) token_error(label.start, "Undefined label " + label.name);
            label.thedef = ldef;
        } else if (S.in_loop == 0) croak(type.TYPE + " not inside a loop or switch");
        semicolon();
        var stat = new type({ label: label });
        if (ldef) ldef.references.push(stat);
        return stat;
    }

    function for_() {
        expect("(");
        var init = null;
        if (!is("punc", ";")) {
            init = is("keyword", "const")
                ? (next(), const_(true))
                : is("keyword", "let")
                ? (next(), let_(true))
                : is("keyword", "var")
                ? (next(), var_(true))
                : expression(true);
            if (is("operator", "in")) {
                if (init instanceof AST_Definitions) {
                    if (init.definitions.length > 1) {
                        token_error(init.start, "Only one variable declaration allowed in for..in loop");
                    }
                } else if (!(is_assignable(init) || (init = to_destructured(init)) instanceof AST_Destructured)) {
                    token_error(init.start, "Invalid left-hand side in for..in loop");
                }
                next();
                return for_in(init);
            }
        }
        return regular_for(init);
    }

    function regular_for(init) {
        expect(";");
        var test = is("punc", ";") ? null : expression();
        expect(";");
        var step = is("punc", ")") ? null : expression();
        expect(")");
        return new AST_For({
            init      : init,
            condition : test,
            step      : step,
            body      : in_loop(statement)
        });
    }

    function for_in(init) {
        var obj = expression();
        expect(")");
        return new AST_ForIn({
            init   : init,
            object : obj,
            body   : in_loop(statement)
        });
    }

    function to_funarg(node) {
        if (node instanceof AST_Array) {
            var rest = null;
            if (node.elements[node.elements.length - 1] instanceof AST_Spread) {
                rest = to_funarg(node.elements.pop().expression);
            }
            return new AST_DestructuredArray({
                start: node.start,
                elements: node.elements.map(to_funarg),
                rest: rest,
                end: node.end,
            });
        }
        if (node instanceof AST_Assign) return new AST_DefaultValue({
            start: node.start,
            name: to_funarg(node.left),
            value: node.right,
            end: node.end,
        });
        if (node instanceof AST_DefaultValue) {
            node.name = to_funarg(node.name);
            return node;
        }
        if (node instanceof AST_DestructuredArray) {
            node.elements = node.elements.map(to_funarg);
            if (node.rest) node.rest = to_funarg(node.rest);
            return node;
        }
        if (node instanceof AST_DestructuredObject) {
            node.properties.forEach(function(prop) {
                prop.value = to_funarg(prop.value);
            });
            if (node.rest) node.rest = to_funarg(node.rest);
            return node;
        }
        if (node instanceof AST_Hole) return node;
        if (node instanceof AST_Object) {
            var rest = null;
            if (node.properties[node.properties.length - 1] instanceof AST_Spread) {
                rest = to_funarg(node.properties.pop().expression);
            }
            return new AST_DestructuredObject({
                start: node.start,
                properties: node.properties.map(function(prop) {
                    if (!(prop instanceof AST_ObjectKeyVal)) token_error(prop.start, "Invalid destructuring assignment");
                    return new AST_DestructuredKeyVal({
                        start: prop.start,
                        key: prop.key,
                        value: to_funarg(prop.value),
                        end: prop.end,
                    });
                }),
                rest: rest,
                end: node.end,
            });
        }
        if (node instanceof AST_SymbolFunarg) return node;
        if (node instanceof AST_SymbolRef) return new AST_SymbolFunarg(node);
        token_error(node.start, "Invalid arrow parameter");
    }

    function arrow(exprs, start, async) {
        var was_async = S.in_async;
        S.in_async = async;
        var was_funarg = S.in_funarg;
        S.in_funarg = S.in_function;
        var argnames = exprs.map(to_funarg);
        var rest = exprs.rest || null;
        if (rest) rest = to_funarg(rest);
        S.in_funarg = was_funarg;
        expect("=>");
        var body, value;
        var loop = S.in_loop;
        var labels = S.labels;
        ++S.in_function;
        S.in_directives = true;
        S.input.push_directives_stack();
        S.in_loop = 0;
        S.labels = [];
        if (is("punc", "{")) {
            body = block_();
            value = null;
            if (S.input.has_directive("use strict")) {
                argnames.forEach(strict_verify_symbol);
            }
        } else {
            body = [];
            value = maybe_assign();
        }
        S.input.pop_directives_stack();
        --S.in_function;
        S.in_loop = loop;
        S.labels = labels;
        S.in_async = was_async;
        return new (async ? AST_AsyncArrow : AST_Arrow)({
            start: start,
            argnames: argnames,
            rest: rest,
            body: body,
            value: value,
            end: prev(),
        });
    }

    var function_ = function(ctor) {
        var was_async = S.in_async;
        var name;
        if (ctor === AST_AsyncDefun) {
            name = as_symbol(AST_SymbolDefun);
            S.in_async = true;
        } else if (ctor === AST_Defun) {
            name = as_symbol(AST_SymbolDefun);
            S.in_async = false;
        } else {
            S.in_async = ctor === AST_AsyncFunction;
            name = as_symbol(AST_SymbolLambda, true);
        }
        if (name && ctor !== AST_Accessor && !(name instanceof AST_SymbolDeclaration))
            unexpected(prev());
        expect("(");
        var was_funarg = S.in_funarg;
        S.in_funarg = S.in_function;
        var argnames = expr_list(")", !options.strict, false, function() {
            return maybe_default(AST_SymbolFunarg);
        });
        S.in_funarg = was_funarg;
        var loop = S.in_loop;
        var labels = S.labels;
        ++S.in_function;
        S.in_directives = true;
        S.input.push_directives_stack();
        S.in_loop = 0;
        S.labels = [];
        var body = block_();
        if (S.input.has_directive("use strict")) {
            if (name) strict_verify_symbol(name);
            argnames.forEach(strict_verify_symbol);
            if (argnames.rest) strict_verify_symbol(argnames.rest);
        }
        S.input.pop_directives_stack();
        --S.in_function;
        S.in_loop = loop;
        S.labels = labels;
        S.in_async = was_async;
        return new ctor({
            name: name,
            argnames: argnames,
            rest: argnames.rest || null,
            body: body
        });
    };

    function if_() {
        var cond = parenthesised(), body = statement(), belse = null;
        if (is("keyword", "else")) {
            next();
            belse = statement();
        }
        return new AST_If({
            condition   : cond,
            body        : body,
            alternative : belse
        });
    }

    function block_() {
        expect("{");
        var a = [];
        while (!is("punc", "}")) {
            if (is("eof")) expect("}");
            a.push(statement());
        }
        next();
        return a;
    }

    function switch_body_() {
        expect("{");
        var a = [], branch, cur, default_branch, tmp;
        while (!is("punc", "}")) {
            if (is("eof")) expect("}");
            if (is("keyword", "case")) {
                if (branch) branch.end = prev();
                cur = [];
                branch = new AST_Case({
                    start      : (tmp = S.token, next(), tmp),
                    expression : expression(),
                    body       : cur
                });
                a.push(branch);
                expect(":");
            } else if (is("keyword", "default")) {
                if (branch) branch.end = prev();
                if (default_branch) croak("More than one default clause in switch statement");
                cur = [];
                branch = new AST_Default({
                    start : (tmp = S.token, next(), expect(":"), tmp),
                    body  : cur
                });
                a.push(branch);
                default_branch = branch;
            } else {
                if (!cur) unexpected();
                cur.push(statement());
            }
        }
        if (branch) branch.end = prev();
        next();
        return a;
    }

    function try_() {
        var body = block_(), bcatch = null, bfinally = null;
        if (is("keyword", "catch")) {
            var start = S.token;
            next();
            var name = null;
            if (is("punc", "(")) {
                next();
                name = maybe_destructured(AST_SymbolCatch);
                expect(")");
            }
            bcatch = new AST_Catch({
                start   : start,
                argname : name,
                body    : block_(),
                end     : prev()
            });
        }
        if (is("keyword", "finally")) {
            var start = S.token;
            next();
            bfinally = new AST_Finally({
                start : start,
                body  : block_(),
                end   : prev()
            });
        }
        if (!bcatch && !bfinally)
            croak("Missing catch/finally blocks");
        return new AST_Try({
            body     : body,
            bcatch   : bcatch,
            bfinally : bfinally
        });
    }

    function vardefs(type, no_in) {
        var a = [];
        for (;;) {
            var start = S.token;
            var name = maybe_destructured(type);
            var value = null;
            if (is("operator", "=")) {
                next();
                value = maybe_assign(no_in);
            } else if (!no_in && (type === AST_SymbolConst || name instanceof AST_Destructured)) {
                croak("Missing initializer in declaration");
            }
            a.push(new AST_VarDef({
                start : start,
                name  : name,
                value : value,
                end   : prev()
            }));
            if (!is("punc", ","))
                break;
            next();
        }
        return a;
    }

    var const_ = function(no_in) {
        return new AST_Const({
            start       : prev(),
            definitions : vardefs(AST_SymbolConst, no_in),
            end         : prev()
        });
    };

    var let_ = function(no_in) {
        return new AST_Let({
            start       : prev(),
            definitions : vardefs(AST_SymbolLet, no_in),
            end         : prev()
        });
    };

    var var_ = function(no_in) {
        return new AST_Var({
            start       : prev(),
            definitions : vardefs(AST_SymbolVar, no_in),
            end         : prev()
        });
    };

    var new_ = function(allow_calls) {
        var start = S.token;
        expect_token("operator", "new");
        var newexp = expr_atom(false), args;
        if (is("punc", "(")) {
            next();
            args = expr_list(")", !options.strict);
        } else {
            args = [];
        }
        var call = new AST_New({
            start      : start,
            expression : newexp,
            args       : args,
            end        : prev()
        });
        mark_pure(call);
        return subscripts(call, allow_calls);
    };

    function as_atom_node() {
        var tok = S.token, ret;
        switch (tok.type) {
          case "num":
            ret = new AST_Number({ start: tok, end: tok, value: tok.value });
            break;
          case "bigint":
            ret = new AST_BigInt({ start: tok, end: tok, value: tok.value });
            break;
          case "string":
            ret = new AST_String({
                start : tok,
                end   : tok,
                value : tok.value,
                quote : tok.quote
            });
            break;
          case "regexp":
            ret = new AST_RegExp({ start: tok, end: tok, value: tok.value });
            break;
          case "atom":
            switch (tok.value) {
              case "false":
                ret = new AST_False({ start: tok, end: tok });
                break;
              case "true":
                ret = new AST_True({ start: tok, end: tok });
                break;
              case "null":
                ret = new AST_Null({ start: tok, end: tok });
                break;
            }
            break;
        }
        next();
        return ret;
    }

    var expr_atom = function(allow_calls) {
        if (is("operator", "new")) {
            return new_(allow_calls);
        }
        var start = S.token;
        if (is("punc")) {
            switch (start.value) {
              case "(":
                next();
                if (is("punc", ")")) {
                    next();
                    return arrow([], start);
                }
                var ex = expression(false, true);
                var len = start.comments_before.length;
                [].unshift.apply(ex.start.comments_before, start.comments_before);
                start.comments_before.length = 0;
                start.comments_before = ex.start.comments_before;
                start.comments_before_length = len;
                if (len == 0 && start.comments_before.length > 0) {
                    var comment = start.comments_before[0];
                    if (!comment.nlb) {
                        comment.nlb = start.nlb;
                        start.nlb = false;
                    }
                }
                start.comments_after = ex.start.comments_after;
                ex.start = start;
                expect(")");
                var end = prev();
                end.comments_before = ex.end.comments_before;
                [].push.apply(ex.end.comments_after, end.comments_after);
                end.comments_after.length = 0;
                end.comments_after = ex.end.comments_after;
                ex.end = end;
                if (ex instanceof AST_Call) mark_pure(ex);
                if (is("punc", "=>")) return arrow(ex instanceof AST_Sequence ? ex.expressions : [ ex ], start);
                return subscripts(ex, allow_calls);
              case "[":
                return subscripts(array_(), allow_calls);
              case "{":
                return subscripts(object_(), allow_calls);
            }
            unexpected();
        }
        if (is("keyword", "function")) {
            next();
            var func = function_(AST_Function);
            func.start = start;
            func.end = prev();
            return subscripts(func, allow_calls);
        }
        if (is("name")) {
            var sym = _make_symbol(AST_SymbolRef, start);
            next();
            if (sym.name == "async") {
                if (is("keyword", "function")) {
                    next();
                    var func = function_(AST_AsyncFunction);
                    func.start = start;
                    func.end = prev();
                    return subscripts(func, allow_calls);
                }
                if (is("name")) {
                    start = S.token;
                    sym = _make_symbol(AST_SymbolRef, start);
                    next();
                    return arrow([ sym ], start, true);
                }
                if (is("punc", "(")) {
                    var call = subscripts(sym, allow_calls);
                    if (!is("punc", "=>")) return call;
                    var args = call.args;
                    if (args[args.length - 1] instanceof AST_Spread) {
                        args.rest = args.pop().expression;
                    }
                    return arrow(args, start, true);
                }
            }
            return is("punc", "=>") ? arrow([ sym ], start) : subscripts(sym, allow_calls);
        }
        if (ATOMIC_START_TOKEN[S.token.type]) {
            return subscripts(as_atom_node(), allow_calls);
        }
        unexpected();
    };

    function expr_list(closing, allow_trailing_comma, allow_empty, parser) {
        if (!parser) parser = maybe_assign;
        var first = true, a = [];
        while (!is("punc", closing)) {
            if (first) first = false; else expect(",");
            if (allow_trailing_comma && is("punc", closing)) break;
            if (allow_empty && is("punc", ",")) {
                a.push(new AST_Hole({ start: S.token, end: S.token }));
            } else if (!is("operator", "...")) {
                a.push(parser());
            } else if (parser === maybe_assign) {
                a.push(new AST_Spread({
                    start: S.token,
                    expression: (next(), parser()),
                    end: prev(),
                }));
            } else {
                next();
                a.rest = parser();
                if (a.rest instanceof AST_DefaultValue) token_error(a.rest.start, "Invalid rest parameter");
                break;
            }
        }
        expect(closing);
        return a;
    }

    var array_ = embed_tokens(function() {
        expect("[");
        return new AST_Array({
            elements: expr_list("]", !options.strict, true)
        });
    });

    var create_accessor = embed_tokens(function() {
        return function_(AST_Accessor);
    });

    var object_ = embed_tokens(function() {
        expect("{");
        var first = true, a = [];
        while (!is("punc", "}")) {
            if (first) first = false; else expect(",");
            // allow trailing comma
            if (!options.strict && is("punc", "}")) break;
            var start = S.token;
            if (is("operator", "...")) {
                next();
                a.push(new AST_Spread({
                    start: start,
                    expression: maybe_assign(),
                    end: prev(),
                }));
                continue;
            }
            if (is_token(peek(), "operator", "=")) {
                var name = as_symbol(AST_SymbolRef);
                next();
                a.push(new AST_ObjectKeyVal({
                    start: start,
                    key: start.value,
                    value: new AST_Assign({
                        start: start,
                        left: name,
                        operator: "=",
                        right: maybe_assign(),
                        end: prev(),
                    }),
                    end: prev(),
                }));
                continue;
            }
            if (is_token(peek(), "punc", ",") || is_token(peek(), "punc", "}")) {
                a.push(new AST_ObjectKeyVal({
                    start: start,
                    key: start.value,
                    value: as_symbol(AST_SymbolRef),
                    end: prev(),
                }));
                continue;
            }
            var key = as_property_key();
            if (is("punc", "(")) {
                var func_start = S.token;
                var func = function_(AST_Function);
                func.start = func_start;
                func.end = prev();
                a.push(new AST_ObjectKeyVal({
                    start: start,
                    key: key,
                    value: func,
                    end: prev(),
                }));
                continue;
            }
            if (is("punc", ":")) {
                next();
                a.push(new AST_ObjectKeyVal({
                    start: start,
                    key: key,
                    value: maybe_assign(),
                    end: prev(),
                }));
                continue;
            }
            if (start.type == "name") switch (key) {
              case "async":
                key = as_property_key();
                var func_start = S.token;
                var func = function_(AST_AsyncFunction);
                func.start = func_start;
                func.end = prev();
                a.push(new AST_ObjectKeyVal({
                    start: start,
                    key: key,
                    value: func,
                    end: prev(),
                }));
                continue;
              case "get":
                a.push(new AST_ObjectGetter({
                    start: start,
                    key: as_property_key(),
                    value: create_accessor(),
                    end: prev(),
                }));
                continue;
              case "set":
                a.push(new AST_ObjectSetter({
                    start: start,
                    key: as_property_key(),
                    value: create_accessor(),
                    end: prev(),
                }));
                continue;
            }
            unexpected();
        }
        next();
        return new AST_Object({ properties: a });
    });

    function as_property_key() {
        var tmp = S.token;
        switch (tmp.type) {
          case "operator":
            if (!KEYWORDS[tmp.value]) unexpected();
          case "num":
          case "string":
          case "name":
          case "keyword":
          case "atom":
            next();
            return "" + tmp.value;
          case "punc":
            expect("[");
            var key = maybe_assign();
            expect("]");
            return key;
          default:
            unexpected();
        }
    }

    function as_name() {
        var name = S.token.value;
        expect_token("name");
        return name;
    }

    function _make_symbol(type, token) {
        var name = token.value;
        if (name === "await" && S.in_async) unexpected(token);
        return new (name === "this" ? AST_This : type)({
            name: "" + name,
            start: token,
            end: token,
        });
    }

    function strict_verify_symbol(sym) {
        if (sym.name == "arguments" || sym.name == "eval")
            token_error(sym.start, "Unexpected " + sym.name + " in strict mode");
    }

    function as_symbol(type, noerror) {
        if (!is("name")) {
            if (!noerror) croak("Name expected");
            return null;
        }
        var sym = _make_symbol(type, S.token);
        if (S.input.has_directive("use strict") && sym instanceof AST_SymbolDeclaration) {
            strict_verify_symbol(sym);
        }
        next();
        return sym;
    }

    function maybe_destructured(type) {
        var start = S.token;
        if (is("punc", "[")) {
            next();
            var elements = expr_list("]", !options.strict, true, function() {
                return maybe_default(type);
            });
            return new AST_DestructuredArray({
                start: start,
                elements: elements,
                rest: elements.rest || null,
                end: prev(),
            });
        }
        if (is("punc", "{")) {
            next();
            var first = true, a = [], rest = null;
            while (!is("punc", "}")) {
                if (first) first = false; else expect(",");
                // allow trailing comma
                if (!options.strict && is("punc", "}")) break;
                var key_start = S.token;
                if (is("punc", "[") || is_token(peek(), "punc", ":")) {
                    var key = as_property_key();
                    expect(":");
                    a.push(new AST_DestructuredKeyVal({
                        start: key_start,
                        key: key,
                        value: maybe_default(type),
                        end: prev(),
                    }));
                    continue;
                }
                if (is("operator", "...")) {
                    next();
                    rest = maybe_destructured(type);
                    break;
                }
                var name = as_symbol(type);
                if (is("operator", "=")) {
                    next();
                    name = new AST_DefaultValue({
                        start: name.start,
                        name: name,
                        value: maybe_assign(),
                        end: prev(),
                    });
                }
                a.push(new AST_DestructuredKeyVal({
                    start: key_start,
                    key: key_start.value,
                    value: name,
                    end: prev(),
                }));
            }
            expect("}");
            return new AST_DestructuredObject({
                start: start,
                properties: a,
                rest: rest,
                end: prev(),
            });
        }
        return as_symbol(type);
    }

    function maybe_default(type) {
        var start = S.token;
        var name = maybe_destructured(type);
        if (!is("operator", "=")) return name;
        next();
        return new AST_DefaultValue({
            start: start,
            name: name,
            value: maybe_assign(),
            end: prev(),
        });
    }

    function mark_pure(call) {
        var start = call.start;
        var comments = start.comments_before;
        var i = HOP(start, "comments_before_length") ? start.comments_before_length : comments.length;
        while (--i >= 0) {
            var comment = comments[i];
            if (/[@#]__PURE__/.test(comment.value)) {
                call.pure = comment;
                break;
            }
        }
    }

    var subscripts = function(expr, allow_calls) {
        var start = expr.start;
        if (is("punc", ".")) {
            next();
            return subscripts(new AST_Dot({
                start      : start,
                expression : expr,
                property   : as_name(),
                end        : prev()
            }), allow_calls);
        }
        if (is("punc", "[")) {
            next();
            var prop = expression();
            expect("]");
            return subscripts(new AST_Sub({
                start      : start,
                expression : expr,
                property   : prop,
                end        : prev()
            }), allow_calls);
        }
        if (allow_calls && is("punc", "(")) {
            next();
            var call = new AST_Call({
                start      : start,
                expression : expr,
                args       : expr_list(")", !options.strict),
                end        : prev()
            });
            mark_pure(call);
            return subscripts(call, true);
        }
        return expr;
    };

    function maybe_unary() {
        var start = S.token;
        if (is("operator") && UNARY_PREFIX[start.value]) {
            next();
            handle_regexp();
            var ex = make_unary(AST_UnaryPrefix, start, maybe_await());
            ex.start = start;
            ex.end = prev();
            return ex;
        }
        var val = expr_atom(true);
        while (is("operator") && UNARY_POSTFIX[S.token.value] && !has_newline_before(S.token)) {
            val = make_unary(AST_UnaryPostfix, S.token, val);
            val.start = start;
            val.end = S.token;
            next();
        }
        return val;
    }

    function make_unary(ctor, token, expr) {
        var op = token.value;
        switch (op) {
          case "++":
          case "--":
            if (!is_assignable(expr))
                token_error(token, "Invalid use of " + op + " operator");
            break;
          case "delete":
            if (expr instanceof AST_SymbolRef && S.input.has_directive("use strict"))
                token_error(expr.start, "Calling delete on expression not allowed in strict mode");
            break;
        }
        return new ctor({ operator: op, expression: expr });
    }

    function maybe_await() {
        var start = S.token;
        if (!(S.in_async && is("name", "await"))) return maybe_unary();
        if (S.in_funarg === S.in_function) croak("Invalid use of await in function argument");
        S.input.context().regex_allowed = true;
        next();
        return new AST_Await({
            start: start,
            expression: maybe_await(),
            end: prev(),
        });
    }

    var expr_op = function(left, min_prec, no_in) {
        var op = is("operator") ? S.token.value : null;
        if (op == "in" && no_in) op = null;
        var prec = op != null ? PRECEDENCE[op] : null;
        if (prec != null && prec > min_prec) {
            next();
            var right = expr_op(maybe_await(), op == "**" ? prec - 1 : prec, no_in);
            return expr_op(new AST_Binary({
                start    : left.start,
                left     : left,
                operator : op,
                right    : right,
                end      : right.end
            }), min_prec, no_in);
        }
        return left;
    };

    function expr_ops(no_in) {
        return expr_op(maybe_await(), 0, no_in);
    }

    var maybe_conditional = function(no_in) {
        var start = S.token;
        var expr = expr_ops(no_in);
        if (is("operator", "?")) {
            next();
            var yes = maybe_assign();
            expect(":");
            return new AST_Conditional({
                start       : start,
                condition   : expr,
                consequent  : yes,
                alternative : maybe_assign(no_in),
                end         : prev()
            });
        }
        return expr;
    };

    function is_assignable(expr) {
        return expr instanceof AST_PropAccess || expr instanceof AST_SymbolRef;
    }

    function to_destructured(node) {
        if (node instanceof AST_Array) {
            var rest = null;
            if (node.elements[node.elements.length - 1] instanceof AST_Spread) {
                rest = to_destructured(node.elements.pop().expression);
                if (!(rest instanceof AST_Destructured || is_assignable(rest))) return node;
            }
            var elements = node.elements.map(to_destructured);
            return all(elements, function(node) {
                return node instanceof AST_DefaultValue
                    || node instanceof AST_Destructured
                    || node instanceof AST_Hole
                    || is_assignable(node);
            }) ? new AST_DestructuredArray({
                start: node.start,
                elements: elements,
                rest: rest,
                end: node.end,
            }) : node;
        }
        if (node instanceof AST_Assign) {
            var name = to_destructured(node.left);
            return name instanceof AST_Destructured || is_assignable(name) ? new AST_DefaultValue({
                start: node.start,
                name: name,
                value: node.right,
                end: node.end,
            }) : node;
        }
        if (!(node instanceof AST_Object)) return node;
        var rest = null;
        if (node.properties[node.properties.length - 1] instanceof AST_Spread) {
            rest = to_destructured(node.properties.pop().expression);
            if (!(rest instanceof AST_Destructured || is_assignable(rest))) return node;
        }
        var props = [];
        for (var i = 0; i < node.properties.length; i++) {
            var prop = node.properties[i];
            if (!(prop instanceof AST_ObjectKeyVal)) return node;
            var value = to_destructured(prop.value);
            if (!(value instanceof AST_DefaultValue || value instanceof AST_Destructured || is_assignable(value))) {
                return node;
            }
            props.push(new AST_DestructuredKeyVal({
                start: prop.start,
                key: prop.key,
                value: value,
                end: prop.end,
            }));
        }
        return new AST_DestructuredObject({
            start: node.start,
            properties: props,
            rest: rest,
            end: node.end,
        });
    }

    function maybe_assign(no_in) {
        var start = S.token;
        var left = maybe_conditional(no_in), val = S.token.value;
        if (is("operator") && ASSIGNMENT[val]) {
            if (is_assignable(left) || val == "=" && (left = to_destructured(left)) instanceof AST_Destructured) {
                next();
                return new AST_Assign({
                    start    : start,
                    left     : left,
                    operator : val,
                    right    : maybe_assign(no_in),
                    end      : prev()
                });
            }
            croak("Invalid assignment");
        }
        return left;
    }

    function expression(no_in, maybe_arrow) {
        var start = S.token;
        var exprs = [];
        while (true) {
            if (maybe_arrow && is("operator", "...")) {
                next();
                exprs.rest = maybe_destructured(AST_SymbolFunarg);
                break;
            }
            exprs.push(maybe_assign(no_in));
            if (!is("punc", ",")) break;
            next();
            if (maybe_arrow && is("punc", ")") && is_token(peek(), "punc", "=>")) break;
        }
        return exprs.length == 1 && !exprs.rest ? exprs[0] : new AST_Sequence({
            start: start,
            expressions: exprs,
            end: prev(),
        });
    }

    function in_loop(cont) {
        ++S.in_loop;
        var ret = cont();
        --S.in_loop;
        return ret;
    }

    if (options.expression) {
        handle_regexp();
        var exp = expression();
        expect_token("eof");
        return exp;
    }

    return function() {
        var start = S.token;
        var body = [];
        S.input.push_directives_stack();
        while (!is("eof"))
            body.push(statement());
        S.input.pop_directives_stack();
        var end = prev();
        var toplevel = options.toplevel;
        if (toplevel) {
            toplevel.body = toplevel.body.concat(body);
            toplevel.end = end;
        } else {
            toplevel = new AST_Toplevel({ start: start, body: body, end: end });
        }
        return toplevel;
    }();
}
