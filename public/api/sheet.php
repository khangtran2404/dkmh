<?php
// Proxy đọc Google Sheet đã publish (Google không trả CORS nên trình duyệt không đọc trực tiếp được).
// GET ?url=<link sheet>[&gid=<gid>][&nocache=1]
// Trả JSON: { sheets: [{name, gid}], gid, html }

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

const CACHE_TTL = 300;
const UA = 'Mozilla/5.0 (dkmh.local timetable helper)';

function fail(int $code, string $msg): void {
    http_response_code($code);
    echo json_encode(['error' => $msg], JSON_UNESCAPED_UNICODE);
    exit;
}

function fetch_url(string $url): string {
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS => 5,
        CURLOPT_TIMEOUT => 20,
        CURLOPT_USERAGENT => UA,
        CURLOPT_PROTOCOLS => CURLPROTO_HTTPS,
        CURLOPT_REDIR_PROTOCOLS => CURLPROTO_HTTPS,
    ]);
    $body = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    $err = curl_error($ch);
    curl_close($ch);
    if ($body === false) fail(502, "Không tải được sheet: $err");
    if ($status !== 200) fail(502, "Google trả về HTTP $status. Kiểm tra sheet đã được 'Publish to web' chưa.");
    return $body;
}

function cached_fetch(string $url, bool $nocache): string {
    // Thư mục riêng theo user của tiến trình (CLI và PHP-FPM chạy bằng user khác nhau)
    $uid = function_exists('posix_geteuid') ? posix_geteuid() : get_current_user();
    $dir = sys_get_temp_dir() . "/dkmh-cache-$uid";
    if (!is_dir($dir)) @mkdir($dir, 0700, true);
    $file = $dir . '/' . sha1($url) . '.html';
    if (!$nocache && is_file($file) && time() - filemtime($file) < CACHE_TTL) {
        $body = @file_get_contents($file);
        if ($body !== false) return $body;
    }
    $body = fetch_url($url);
    if (is_dir($dir) && is_writable($dir)) @file_put_contents($file, $body, LOCK_EX);
    return $body;
}

$raw = trim($_GET['url'] ?? '');
$gid = preg_replace('/\D/', '', $_GET['gid'] ?? '');
$nocache = !empty($_GET['nocache']);
if ($raw === '') fail(400, 'Thiếu tham số url');

$p = parse_url($raw);
if (!$p || ($p['scheme'] ?? '') !== 'https' || ($p['host'] ?? '') !== 'docs.google.com') {
    fail(400, 'Chỉ hỗ trợ link https://docs.google.com/spreadsheets/...');
}
$path = $p['path'] ?? '';
parse_str($p['query'] ?? '', $q);
if ($gid === '' && !empty($q['gid'])) $gid = preg_replace('/\D/', '', $q['gid']);
if ($gid === '' && preg_match('/gid=(\d+)/', $p['fragment'] ?? '', $m)) $gid = $m[1];

// Chuẩn hoá về link gốc .../pubhtml
if (preg_match('#^/spreadsheets/d/e/([A-Za-z0-9_-]+)#', $path, $m)) {
    $base = "https://docs.google.com/spreadsheets/d/e/{$m[1]}";
} elseif (preg_match('#^/spreadsheets/d/([A-Za-z0-9_-]+)#', $path, $m)) {
    // Link /d/<id>/edit: sheet phải được publish hoặc chia sẻ công khai
    $base = "https://docs.google.com/spreadsheets/d/{$m[1]}";
} else {
    fail(400, 'Link Google Sheet không hợp lệ');
}

$index = cached_fetch("$base/pubhtml", $nocache);

// Danh sách sheet: items.push({name: "Sheet1", pageUrl: "...gid=123"
$sheets = [];
if (preg_match_all('/items\.push\(\{name:\s*"((?:[^"\\\\]|\\\\.)*)",\s*pageUrl:\s*"((?:[^"\\\\]|\\\\.)*)"/', $index, $mm, PREG_SET_ORDER)) {
    foreach ($mm as $it) {
        $name = json_decode('"' . $it[1] . '"') ?? $it[1];
        $page = json_decode('"' . $it[2] . '"') ?? $it[2];
        if (preg_match('/gid=(\d+)/', $page, $g)) $sheets[] = ['name' => $name, 'gid' => $g[1]];
    }
}

if ($sheets) {
    if ($gid === '' || !in_array($gid, array_column($sheets, 'gid'), true)) $gid = $sheets[0]['gid'];
    $html = cached_fetch("$base/pubhtml/sheet?headers=false&gid=$gid", $nocache);
} else {
    // Sheet chỉ có 1 tab: bảng nằm luôn trong trang pubhtml
    $html = $index;
}

if (stripos($html, '<table') === false) fail(502, 'Không tìm thấy bảng dữ liệu trong sheet');

// Chỉ trả phần <table>, bỏ thuộc tính trình bày (class/style/id), cột số dòng <th> và thẻ <div> bọc chữ:
// giữ nguyên rowspan/colspan và nội dung -> nhỏ hơn ~55%, trình duyệt parse nhanh hơn
if (preg_match('#<table.*</table>#is', $html, $t)) $html = $t[0];
$html = preg_replace('#<th\b[^>]*>.*?</th>#is', '', $html);
$html = preg_replace('#\s(?:class|style|id|dir|cellspacing|cellpadding)="[^"]*"#i', '', $html);
$html = preg_replace('#</?(?:div|thead|colgroup|col)\b[^>]*>#i', '', $html);

echo json_encode(['sheets' => $sheets, 'gid' => $gid, 'html' => $html], JSON_UNESCAPED_UNICODE);
