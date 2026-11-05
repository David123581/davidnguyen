# Bảo vệ app

Web app cho tổ trưởng bảo vệ ngân hàng. Không cần cài thư viện (chỉ Node.js ≥ 22.5, dữ liệu lưu SQLite).

| Đối tượng | Địa chỉ |
|---|---|
| **Khách hàng** lấy số trên điện thoại (dán QR ở cửa) | `/lay-so` (hoặc gốc `/`) |
| **Nội bộ bảo vệ**: gọi số, kiểm tra, lịch trực, đánh giá, danh bạ, cài đặt (cần PIN) | `/bao-ve` |
| Màn hình tivi + giọng đọc | `/tv` |
| In phiếu đánh giá | `/in-danh-gia?month=YYYY-MM&prefill=1` (mở từ tab Đánh giá tháng) |

## Chạy thử trên máy

```bash
cd bao-ve-app
ADMIN_PIN=123456 npm start      # mở http://127.0.0.1:3000
npm test
```
Không đặt `ADMIN_PIN` thì app tự sinh PIN ngẫu nhiên và in ra console lần chạy đầu. Quên PIN: `npm run reset-pin -- 654321`.

## Triển khai lên VPS (Ubuntu/Debian)

1. Cài Node 22: `curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs`
2. Đưa mã nguồn lên `/opt/bao-ve-app`, tạo người dùng và thư mục dữ liệu:
   ```bash
   sudo useradd -r -s /usr/sbin/nologin baove
   sudo mkdir -p /var/lib/bao-ve && sudo chown baove: /var/lib/bao-ve
   ```
3. Chép `deploy/bao-ve.service` vào `/etc/systemd/system/`, **sửa `ADMIN_PIN`**, rồi `sudo systemctl enable --now bao-ve`.
4. Cài Caddy (`sudo apt install caddy`), chép `deploy/Caddyfile` vào `/etc/caddy/Caddyfile`, đổi tên miền, `sudo systemctl reload caddy`. Mở cổng 80/443, **không** mở cổng 3000 ra ngoài.
5. Sao lưu: `DATA_DIR=/var/lib/bao-ve npm run backup` (đặt cron hằng ngày) và chép file `backup-*.db` ra nơi khác.

## Dùng hằng ngày

- **Tivi:** mở `/tv` bằng Edge/Chrome, bấm "Bật âm thanh" một lần (trình duyệt bắt buộc), tivi sẽ tự vào toàn màn hình. Cần máy có giọng đọc tiếng Việt (Edge/Chrome trên Windows, Chrome trên Android có sẵn).
- **Khách:** quét QR → nhập tên (không bắt buộc) → nhận số. Tivi đọc: "Mời khách hàng *Nguyễn Văn An*, số 1, đến quầy 2".
- **Gọi số:** trong `/bao-ve`, bấm *GỌI SỐ TIẾP → QUẦY n* của quầy đang rảnh. Khách trước đó ở quầy này tự biến khỏi màn hình; *Gọi lại / Vắng / Xong* có sẵn trên từng quầy.
- **Chống lấy số từ xa:** Cài đặt → bật "Chỉ cho lấy số khi quét mã QR dán tại quầy"; khi đó QR có thêm mã bí mật và có nút *Đổi mã QR*.
- **Khách không có điện thoại:** bấm *Cấp số cho khách không có điện thoại*.
- **Số thứ tự** tăng dần 001, 002, … trong ngày và tự bắt đầu lại từ 001 vào ngày mới (giờ Việt Nam).

## Bảo mật

- Quản lý bằng một mã PIN (băm scrypt), khoá 10 phút sau 5 lần nhập sai, cookie HttpOnly + SameSite=Strict, API chỉ nhận JSON.
- Trang lấy số giới hạn số lượt theo IP (`TICKET_IP_LIMIT`, mặc định 30/giờ). Không thu số điện thoại khách.
- Chạy sau Caddy/HTTPS (`TRUST_PROXY=1`).

## Chưa có (có thể làm tiếp)

Đăng nhập riêng cho từng nhân viên, logo công ty trên phiếu, in thẻ số bằng máy in nhiệt, giọng đọc từ máy chủ (cho tivi không có giọng tiếng Việt).
