<?php
// reverse-qa PHP rule pack: parse every .php file under a source root with PHP-Parser and print raw facts as JSON.
// Facts only, no judgments: the Node normalizer (plugin/lib/inventory.mjs) classifies them, so every stack's pack
// emits the same shape (plugin/rules/CONTRACT.md).
//   php extract.php <src> [--php-version 7.2] [--exclude <dir>]...
declare(strict_types=1);

require '/opt/tools/vendor/autoload.php';

use PhpParser\Node;
use PhpParser\Node\Expr;
use PhpParser\Node\Scalar;
use PhpParser\Node\Stmt;
use PhpParser\NodeTraverser;
use PhpParser\NodeVisitorAbstract;
use PhpParser\ParserFactory;
use PhpParser\PhpVersion;

const SQL_RE = '/^\s*\(?\s*(SELECT|INSERT|UPDATE|DELETE|REPLACE)\b/i';
const URL_RE = '~https?://[^\s"\'<>)\\\\]+~i';
const JS_REDIRECT_RE = '~(?:window\.|document\.)?location(?:\.href)?\s*=\s*[\'"]([^\'"]+)[\'"]|location\.(?:replace|assign)\(\s*[\'"]([^\'"]+)[\'"]~i';
const SUPERGLOBALS = ['_GET', '_POST', '_FILES', '_REQUEST', '_COOKIE', '_SERVER'];
const CALLS = ['session_start', 'session_destroy', 'session_regenerate_id', 'session_unset', 'password_hash', 'password_verify',
    'md5', 'sha1', 'crypt', 'hash', 'addslashes', 'mysqli_real_escape_string', 'htmlspecialchars', 'htmlentities', 'strip_tags',
    'filter_var', 'filter_input', 'move_uploaded_file', 'mysqli_query', 'mysqli_prepare', 'curl_init', 'curl_exec',
    'file_get_contents', 'fopen', 'unlink', 'mail', 'eval', 'exec', 'shell_exec', 'system', 'passthru', 'openssl_encrypt',
    'openssl_decrypt', 'base64_encode', 'base64_decode', 'setcookie', 'rand', 'mt_rand', 'random_bytes', 'uniqid', 'define'];
const METHODS = ['query', 'prepare', 'bind_param', 'execute', 'real_escape_string', 'multi_query', 'escape_string'];

function lineAt(string $text, int $offset, int $startLine): int
{
    return $startLine + substr_count(substr($text, 0, $offset), "\n");
}

/** Flatten a string-ish expression; dynamic parts become "?". Returns null when the node holds no literal text. */
function flatten(Node $e, SplObjectStorage $consumed): ?string
{
    if ($e instanceof Scalar\String_) {
        $consumed->offsetSet($e);
        return $e->value;
    }
    if ($e instanceof Scalar\InterpolatedString) {
        $consumed->offsetSet($e);
        $out = '';
        foreach ($e->parts as $p) {
            $out .= $p instanceof Node\InterpolatedStringPart ? $p->value : '?';
        }
        return $out;
    }
    if ($e instanceof Expr\BinaryOp\Concat) {
        $l = flatten($e->left, $consumed);
        $r = flatten($e->right, $consumed);
        if ($l === null && $r === null) {
            return null;
        }
        return ($l ?? '?') . ($r ?? '?');
    }
    return null;
}

function keyOf(?Node $dim): string
{
    if ($dim instanceof Scalar\String_) {
        return $dim->value;
    }
    if ($dim instanceof Scalar\Int_) {
        return (string) $dim->value;
    }
    return '?';
}

function superglobalName(Node $n): ?string
{
    return $n instanceof Expr\Variable && is_string($n->name) && (in_array($n->name, SUPERGLOBALS, true) || $n->name === '_SESSION')
        ? $n->name : null;
}

function funcName(Node $n): ?string
{
    return $n instanceof Expr\FuncCall && $n->name instanceof Node\Name ? $n->name->toLowerString() : null;
}

function headerLocation(Node $n, SplObjectStorage $scratch): ?string
{
    if (funcName($n) !== 'header' || !isset($n->args[0]) || !($n->args[0] instanceof Node\Arg)) {
        return null;
    }
    $text = flatten($n->args[0]->value, $scratch);
    if ($text === null || !preg_match('/^\s*location\s*:\s*(.*)$/is', $text, $m)) {
        return null;
    }
    return trim($m[1]);
}

final class Collector extends NodeVisitorAbstract
{
    public array $f = ['includes' => [], 'session' => [], 'superglobals' => [], 'sql' => [], 'uploads' => [], 'urls' => [],
        'calls' => [], 'functions' => [], 'html' => []];
    private SplObjectStorage $consumed;
    private SplObjectStorage $sessionSeen;

    public function __construct()
    {
        $this->consumed = new SplObjectStorage();
        $this->sessionSeen = new SplObjectStorage();
    }

    private function session(Node $dimFetch, string $op): void
    {
        if ($this->sessionSeen->offsetExists($dimFetch)) {
            return;
        }
        $this->sessionSeen->offsetSet($dimFetch);
        $this->f['session'][] = ['key' => keyOf($dimFetch->dim), 'op' => $op, 'line' => $dimFetch->getStartLine()];
    }

    private function sessionDims(Node $n, string $op): void
    {
        if ($n instanceof Expr\ArrayDimFetch && superglobalName($n->var) === '_SESSION') {
            $this->session($n, $op);
        }
        foreach ($n->getSubNodeNames() as $name) {
            $v = $n->$name;
            foreach (is_array($v) ? $v : [$v] as $c) {
                if ($c instanceof Node) {
                    $this->sessionDims($c, $op);
                }
            }
        }
    }

    private function text(string $text, int $line, string $context): void
    {
        if (preg_match_all(URL_RE, $text, $m, PREG_OFFSET_CAPTURE)) {
            foreach ($m[0] as [$url, $off]) {
                $before = substr($text, max(0, $off - 24), min(24, $off));
                $ctx = preg_match('/\b(?:href|src)\s*=\s*["\']?$/i', $before) ? 'asset'
                    : (preg_match('/\baction\s*=\s*["\']?$/i', $before) ? 'form-action' : $context);
                $this->f['urls'][] = ['url' => $url, 'line' => lineAt($text, $off, $line), 'context' => $ctx];
            }
        }
        if (preg_match_all(JS_REDIRECT_RE, $text, $m, PREG_OFFSET_CAPTURE | PREG_SET_ORDER)) {
            foreach ($m as $set) {
                $url = ($set[1][0] ?? '') !== '' ? $set[1][0] : ($set[2][0] ?? '');
                $this->f['html'][] = ['kind' => 'js-redirect', 'url' => $url, 'line' => lineAt($text, $set[0][1], $line)];
            }
        }
        if (stripos($text, '<') !== false) {
            $this->f['html'][] = ['kind' => 'chunk', 'text' => $text, 'line' => $line, 'context' => $context];
        }
    }

    public function enterNode(Node $n)
    {
        $line = $n->getStartLine();
        if ($n instanceof Stmt\InlineHTML) {
            $this->text($n->value, $line, 'html');
        } elseif ($n instanceof Expr\Include_) {
            $kinds = [1 => 'include', 2 => 'include_once', 3 => 'require', 4 => 'require_once'];
            $target = flatten($n->expr, new SplObjectStorage());
            $this->f['includes'][] = ['target' => $target ?? '?', 'line' => $line, 'kind' => $kinds[$n->type] ?? 'include'];
        } elseif ($n instanceof Expr\Isset_ || $n instanceof Expr\Empty_) {
            $this->sessionDims($n, 'check');
        } elseif ($n instanceof Expr\Assign || $n instanceof Expr\AssignOp) {
            if ($n->var instanceof Expr\ArrayDimFetch && superglobalName($n->var->var) === '_SESSION') {
                $this->session($n->var, 'write');
            }
        } elseif ($n instanceof Stmt\Unset_) {
            $this->sessionDims($n, 'unset');
        } elseif ($n instanceof Expr\ArrayDimFetch && ($sg = superglobalName($n->var)) !== null) {
            if ($sg === '_SESSION') {
                $this->session($n, 'read');
            } elseif (!($n->var instanceof Expr\ArrayDimFetch)) {
                $this->f['superglobals'][] = ['name' => $sg, 'key' => keyOf($n->dim), 'line' => $line];
            }
        } elseif (($fn = funcName($n)) !== null) {
            if ($fn === 'session_destroy' || $fn === 'session_unset') {
                $this->f['session'][] = ['key' => '*', 'op' => 'unset', 'line' => $line];
            }
            if ($fn === 'move_uploaded_file') {
                $this->f['uploads'][] = ['line' => $line];
            }
            if (in_array($fn, CALLS, true)) {
                $this->f['calls'][] = ['name' => $fn, 'line' => $line];
            }
        } elseif ($n instanceof Expr\MethodCall && $n->name instanceof Node\Identifier) {
            $m = strtolower($n->name->toString());
            if (in_array($m, METHODS, true)) {
                $this->f['calls'][] = ['name' => '->' . $m, 'line' => $line];
            }
        } elseif ($n instanceof Stmt\Function_ || $n instanceof Stmt\ClassMethod) {
            $this->f['functions'][] = ['name' => $n->name->toString(), 'line' => $line];
        }

        if ($n instanceof Expr\BinaryOp\Concat || $n instanceof Scalar\String_ || $n instanceof Scalar\InterpolatedString) {
            if (!$this->consumed->offsetExists($n)) {
                $text = flatten($n, $this->consumed);
                if ($text !== null) {
                    if (preg_match(SQL_RE, $text)) {
                        $this->f['sql'][] = ['text' => preg_replace('/\s+/', ' ', trim($text)), 'line' => $line];
                    }
                    $this->text($text, $line, 'php');
                }
            }
        }
        return null;
    }
}

/** Stmt lists nested in a statement (if/else/loops/switch/try/functions). */
function childLists(Node $n): array
{
    $out = [];
    foreach ($n->getSubNodeNames() as $name) {
        $v = $n->$name;
        if (is_array($v) && $v !== [] && $v[0] instanceof Stmt) {
            $out[] = $v;
        } elseif ($v instanceof Stmt) {
            $out = array_merge($out, childLists($v));
        }
    }
    return $out;
}

function isExit(?Node $s): bool
{
    return $s instanceof Stmt\Expression && $s->expr instanceof Expr\Exit_;
}

/** Output-producing top-level statements before index $i: the evidence for "redirect after output". */
function precedingOutput(array $top, int $i): array
{
    $out = [];
    for ($k = 0; $k < $i; $k++) {
        $s = $top[$k];
        if ($s instanceof Stmt\InlineHTML) {
            $out[] = ['kind' => 'html', 'line' => $s->getStartLine(), 'bytes' => strlen($s->value), 'blank' => trim($s->value) === ''];
        } elseif ($s instanceof Stmt\Echo_) {
            $out[] = ['kind' => 'echo', 'line' => $s->getStartLine()];
        } elseif ($s instanceof Stmt\Expression && $s->expr instanceof Expr\Include_) {
            $out[] = ['kind' => 'include', 'line' => $s->getStartLine(), 'target' => flatten($s->expr->expr, new SplObjectStorage()) ?? '?'];
        }
    }
    return $out;
}

/** $moreAfter: code still runs after this list ends (so a redirect without exit is followed by code). */
function redirects(array $stmts, array $preceding, array &$out, bool $moreAfter): void
{
    $last = count($stmts) - 1;
    foreach (array_values($stmts) as $i => $s) {
        $more = $i < $last || $moreAfter;
        if ($s instanceof Stmt\Expression && ($url = headerLocation($s->expr, new SplObjectStorage())) !== null) {
            $exits = isExit($stmts[$i + 1] ?? null);
            $out[] = ['url' => $url, 'line' => $s->getStartLine(), 'exits' => $exits, 'code_follows' => !$exits && $more,
                'preceded_by' => $preceding];
        }
        foreach (childLists($s) as $list) {
            redirects($list, $preceding, $out, $more);
        }
    }
}

/**
 * Forms and their fields from the file's HTML stream: inline HTML and echoed strings joined in source order, with
 * "?" where PHP output sits between two HTML pieces (so value="<?php echo $x ?>" still reads as one tag).
 */
function forms(array $chunks): array
{
    $forms = [];
    $orphans = [];
    $open = null;
    $re = '~<form\b([^>]*)>|</form\s*>|<(input|select|textarea|button)\b([^>]*)>~i';
    $stream = '';
    $segments = [];
    foreach ($chunks as $c) {
        if ($stream !== '') {
            $stream .= '?';
        }
        $segments[] = ['start' => strlen($stream), 'line' => $c['line'], 'text' => $c['text']];
        $stream .= $c['text'];
    }
    $lineOf = function (int $off) use ($segments): int {
        $seg = $segments[0];
        foreach ($segments as $s) {
            if ($s['start'] <= $off) {
                $seg = $s;
            }
        }
        return lineAt($seg['text'], max(0, $off - $seg['start']), $seg['line']);
    };
    if ($stream !== '' && preg_match_all($re, $stream, $m, PREG_SET_ORDER | PREG_OFFSET_CAPTURE)) {
        foreach ($m as $set) {
            $line = $lineOf($set[0][1]);
            if (($set[1][0] ?? '') !== '' || preg_match('~^<form\b~i', $set[0][0])) {
                $attrs = $set[1][0] ?? '';
                $open = count($forms);
                $forms[] = ['line' => $line, 'action' => attr($attrs, 'action'), 'method' => strtoupper(attr($attrs, 'method') ?? 'GET'),
                    'enctype' => attr($attrs, 'enctype'), 'fields' => []];
            } elseif (stripos($set[0][0], '</form') === 0) {
                $open = null;
            } else {
                $attrs = $set[3][0] ?? '';
                $field = ['tag' => strtolower($set[2][0]), 'name' => attr($attrs, 'name'), 'type' => attr($attrs, 'type'),
                    'required' => (bool) preg_match('/\brequired\b/i', $attrs), 'maxlength' => attr($attrs, 'maxlength'), 'line' => $line];
                if ($open === null) {
                    $orphans[] = $field;
                } else {
                    $forms[$open]['fields'][] = $field;
                }
            }
        }
    }
    return [$forms, $orphans];
}

function attr(string $attrs, string $name): ?string
{
    return preg_match('~\b' . $name . '\s*=\s*(?:"([^"]*)"|\'([^\']*)\'|([^\s>]+))~i', $attrs, $m)
        ? ($m[1] !== '' ? $m[1] : (($m[2] ?? '') !== '' ? $m[2] : ($m[3] ?? ''))) : null;
}

// ---- main -----------------------------------------------------------------------------------------------------
$args = array_slice($argv, 1);
$src = null;
$version = '7.2';
$exclude = ['.git', 'vendor', 'node_modules'];
for ($i = 0; $i < count($args); $i++) {
    if ($args[$i] === '--php-version') {
        $version = $args[++$i];
    } elseif ($args[$i] === '--exclude') {
        $exclude[] = trim($args[++$i], '/');
    } else {
        $src = rtrim($args[$i], '/');
    }
}
if ($src === null || !is_dir($src)) {
    fwrite(STDERR, "usage: extract.php <src> [--php-version 7.2] [--exclude dir]...\n");
    exit(1);
}

$parser = (new ParserFactory())->createForVersion(PhpVersion::fromString($version));
$files = [];
$it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($src, FilesystemIterator::SKIP_DOTS));
foreach ($it as $file) {
    $rel = str_replace('\\', '/', substr($file->getPathname(), strlen($src) + 1));
    if (strtolower($file->getExtension()) !== 'php') {
        continue;
    }
    foreach ($exclude as $ex) {
        if ($rel === $ex || str_starts_with($rel, $ex . '/')) {
            continue 2;
        }
    }
    $code = file_get_contents($file->getPathname());
    $entry = ['path' => $rel, 'lines' => substr_count($code, "\n") + 1, 'parse_error' => null];
    try {
        $ast = $parser->parse($code) ?? [];
    } catch (PhpParser\Error $e) {
        $entry['parse_error'] = $e->getMessage();
        $files[] = $entry;
        continue;
    }
    $collector = new Collector();
    $t = new NodeTraverser();
    $t->addVisitor($collector);
    $t->traverse($ast);
    $f = $collector->f;

    $redirects = [];
    foreach ($ast as $i => $s) {
        redirects([$s], precedingOutput($ast, $i), $redirects, $i < count($ast) - 1);
    }
    $chunks = array_values(array_filter($f['html'], fn ($h) => $h['kind'] === 'chunk'));
    [$formList, $orphans] = forms($chunks);
    $htmlBytes = 0;
    foreach ($ast as $s) {
        if ($s instanceof Stmt\InlineHTML) {
            $htmlBytes += strlen($s->value);
        }
    }
    unset($f['html']);
    $files[] = $entry + $f + [
        'redirects' => $redirects,
        'js_redirects' => array_values(array_map(fn ($h) => ['url' => $h['url'], 'line' => $h['line']],
            array_filter($collector->f['html'], fn ($h) => $h['kind'] === 'js-redirect'))),
        'forms' => $formList,
        'fields_outside_forms' => $orphans,
        'top_level_html_bytes' => $htmlBytes,
    ];
}
usort($files, fn ($a, $b) => strcmp($a['path'], $b['path']));
echo json_encode(['pack' => 'php', 'pack_version' => '1.0.0', 'language_version' => $version, 'files' => $files],
    JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE), "\n";
