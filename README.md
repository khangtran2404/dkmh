# DKMH – Xếp thời khóa biểu đăng ký môn học

Đọc TKB dự kiến từ Google Sheet (Publish to web), lọc môn/lớp học phần và tự xếp các tổ hợp
thời khóa biểu **không trùng lịch**, ưu tiên ngày học liên tiếp, ít ngày đi học, ít ca trống.

## Quy tắc xét trùng
- Các dòng cùng mã lớp học phần là 1 lớp (phải học mọi buổi).
- Hai buổi trùng khi cùng thứ, cùng ca và có ít nhất 1 tuần chung.
- Phòng `LMS`, `BTN` không tính trùng (theo lưu ý của trường); `HTT` (online) vẫn tính.
- Dòng có ngày bắt đầu/kết thúc lệch với cột tuần: xét trùng theo cả hai (tab "Cảnh báo dữ liệu").

## Chạy
```bash
npm install
npm run dev          # dev server Vite (cần proxy /api/sheet.php: dùng nginx + PHP hoặc deploy/server.cjs)
npm test             # test quy tắc; thêm: npm test -- <api.json> [<sheet.csv>] để test với dữ liệu thật
npm run build        # -> dist/
```

- Local (`dkmh.local`): nginx + PHP-FPM, proxy ở `public/api/sheet.php` — cài bằng `sudo bash deploy/install.sh`.
- VPS: `./deploy.sh` (từ máy local, upload qua SSH) hoặc `./deploy.sh --here` (trên VPS sau `git pull`).
  App chạy bằng `deploy/server.cjs` (Node ≥ 18, không cần thư viện), mặc định cổng 1712. Xem `./deploy.sh --help`.

## Cấu trúc
| File | Vai trò |
|---|---|
| `src/sheet.js` | Đọc bảng HTML của sheet (xử lý ô gộp), chuẩn hóa dữ liệu |
| `src/scheduler.js` | Xét trùng + tìm tổ hợp tối ưu (backtracking, branch-and-bound) |
| `src/main.js` | Giao diện, bộ lọc, hiển thị kết quả |
| `public/api/sheet.php` / `deploy/server.cjs` | Proxy đọc Google Sheet (Google không cho CORS) |
