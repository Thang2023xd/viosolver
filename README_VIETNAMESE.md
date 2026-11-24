# VioEdu QA Assistant

**Ngôn ngữ:** [English](README.md) · Tiếng Việt

Tiện ích Chrome hỗ trợ kiểm thử bài tập VioEdu trong phạm vi được ủy quyền. Extension nhận dạng dạng câu hỏi, gửi nội dung đến AI provider đã chọn và có thể điền đáp án để phục vụ quy trình QA.

## AI provider

- **Vireonix.ai** — provider mặc định; dịch vụ có thể áp dụng giới hạn.
- **OpenRouter** — cần API key; model mặc định là `openrouter/free`.
- **Groq** — cần API key; model mặc định là `openai/gpt-oss-120b`. Groq tự quản lý khả dụng và giới hạn của gói miễn phí.

## Cách lấy API key

Truy cập [trang liên hệ nhà cung cấp](https://accessgated.github.io/keys/getkey-obfuscated.html) để gửi yêu cầu. Sau khi xem xét, nhà cung cấp sẽ cấp API key cho bạn. Nhập key đó vào phần cài đặt provider trong extension. Quyền truy cập Vireonix.ai được đăng ký trực tiếp với nhà cung cấp; API key OpenRouter và Groq cần lấy từ các dịch vụ tương ứng.

API key được lưu trong `chrome.storage.local` trên trình duyệt của người dùng. Nội dung câu hỏi và các lựa chọn được gửi tới provider đang chọn. Không dùng extension với dữ liệu cá nhân, mật hoặc dữ liệu học sinh nếu chưa được phép chia sẻ với provider đó.

## Cài bản source trên Chrome

1. Tạo `private-config.js` từ `private-config.example.js`, điền cấu hình xác thực staff nội bộ và giữ file thật ở ngoài Git.
2. Sau khi sửa các file extension, chạy `node scripts/compute-integrity.js` để tạo lại integrity hash.
3. Mở `chrome://extensions/`, bật **Developer mode**, chọn **Load unpacked** và trỏ tới thư mục repository.
4. Chọn provider và lưu API key trong popup hoặc HUD trên trang.

Secret ký staff key cần thiết cho chức năng xác thực và tạo staff key. Không đưa secret vào source control. Script tạo key cũng cần biến môi trường `VIOEDU_STAFF_KEY_SECRET`; xem `scripts/generate-staff-keys.js`.

## Build ZIP tự động

GitHub Actions tự build ZIP từ source khi push lên `main`, push tag phiên bản dạng `v*`, hoặc chạy workflow thủ công. Mỗi lần build đều tạo artifact tải trong tab **Actions**. Push lên `main` cũng cập nhật prerelease `nightly`; tag phiên bản sẽ tạo hoặc cập nhật GitHub Release tương ứng.

Để phát hành bản mới, push source lên GitHub rồi push một tag, ví dụ `v1.8.0`.

## Các file chính

- `background.js` — gọi provider, xác thực staff và integrity check.
- `content.js` / `content.css` — nhận dạng câu hỏi, giao diện HUD và điền đáp án.
- `popup.html` / `popup.js` — cấu hình extension.
- `interceptor.js` — quan sát response câu hỏi của VioEdu để hỗ trợ QA.
- `scripts/compute-integrity.js` — tạo lại hash được pin.

## Quy định repository

Source code được cấp phép theo [MIT License](LICENSE). Xem thêm [Terms](TERMS.md), [Privacy](PRIVACY.md) và [Code of Conduct](CODE_OF_CONDUCT.md). Không upload file ký `.pem`, CRX, cấu hình riêng, whitelist staff hay danh sách staff key.

## Báo lỗi

Báo lỗi có thể tái hiện qua issue tracker riêng tư của repository hoặc liên hệ chủ repository. Không gửi API key, staff key, thông tin học sinh hay ảnh chụp trang chưa che dữ liệu nhạy cảm.
