# Hướng Dẫn Xuất Bản Ứng Dụng GAERU Store Lên Kho Ứng Dụng (Google Play & Apple App Store)

Tài liệu này hướng dẫn chi tiết quy trình xây dựng, ký số và xuất bản ứng dụng mua sắm **GAERU Store** (`com.gaeru.store`) lên:
1. **Google Play Store (Android)**
2. **Apple App Store (iOS)**
3. **Phân phối trực tiếp file APK (Direct Android Package)**

---

## 1. Thông Tin Định Danh Ứng Dụng (App Identity)

- **Tên hiển thị (App Name):** `GAERU Store`
- **Tên đầy đủ:** `GAERU — Mua sắm thiết bị thu âm & sáng tạo`
- **Mã định danh gói (Package ID / Bundle Identifier):** `com.gaeru.store`
- **Phiên bản khởi tạo:** `1.0.0` (Version Code: `1`)
- **Tên miền website chính thức:** `https://gaeru.com`
- **Chính sách quyền riêng tư (Privacy Policy):** `https://gaeru.com/privacy.html`
- **Điều khoản dịch vụ (Terms of Service):** `https://gaeru.com/terms.html`
- **Email hỗ trợ kỹ thuật:** `business@gaeru.com`
- **Hotline hỗ trợ:** `082 919 1080`

---

## 2. Xuất Bản Lên Google Play Store (Dành Cho Điện Thoại Android)

### Bước 2.1: Chuẩn bị tài khoản Google Play Console
1. Đăng ký tài khoản nhà phát triển tại [Google Play Console](https://play.google.com/console) (phí đăng ký 1 lần duy nhất: \$25).
2. Xác minh danh tính doanh nghiệp hoặc cá nhân theo yêu cầu của Google.

### Bước 2.2: Tạo Keystore ký ứng dụng (Upload Key)
Mở terminal/cmd và chạy lệnh sau để sinh file keystore dùng ký bản phát hành:
```bash
keytool -genkey -v -keystore gaeru-release-key.jks -keyalg RSA -keysize 2048 -validity 10000 -alias gaeru-key
```
*Lưu ý: Lưu trữ file `gaeru-release-key.jks` và mật khẩu cẩn thận để cập nhật app các phiên bản sau.*

### Bước 2.3: Build Android App Bundle (.aab)
1. Cấu hình Capacitor:
   ```bash
   cd mobile-app
   npx cap sync android
   ```
2. Mở thư mục `mobile-app/android` bằng **Android Studio**.
3. Vào menu **Build** > **Generate Signed Bundle / APK** > Chọn **Android App Bundle (.aab)**.
4. Chọn file `gaeru-release-key.jks` vừa tạo ở bước trên và bấm **Create**.
5. File `.aab` thành phẩm sẽ nằm tại:
   `mobile-app/android/app/release/app-release.aab`

### Bước 2.4: Tải lên Google Play Console
1. Tại trang quản trị Play Console, bấm **Tạo ứng dụng** (Create App):
   - Tên ứng dụng: `GAERU Store`
   - Ngôn ngữ mặc định: Tiếng Việt (vi-VN)
   - Loại ứng dụng: Ứng dụng (App) & Miễn phí (Free)
2. Điền thông tin gian hàng (Store Listing):
   - Mô tả ngắn: `Ứng dụng mua sắm micro thu âm không dây, thiết bị livestream và phụ kiện chính hãng GAERU.`
   - Mô tả đầy đủ: Giới thiệu các dòng sản phẩm GAERU K9, M3, G1 Ultra, chính sách bảo hành 12 tháng, giao hàng toàn quốc.
   - Icon ứng dụng: Tải lên file 512x512 PNG (`assets/brand/gaeru-app-512.png`).
   - Đồ họa tính năng (Feature Graphic): 1024x500 PNG.
   - Ảnh chụp màn hình điện thoại (Phone Screenshots): Tối thiểu 4 ảnh chụp giao diện cửa hàng và giỏ hàng.
3. Vào mục **Bản phát hành** (Releases) > **Bản phát hành chính thức** (Production) > Tải file `app-release.aab` lên.
4. Gửi bản phát hành để Google xét duyệt (thường mất từ 1 - 3 ngày làm việc).

---

## 3. Xuất Bản Lên Apple App Store (Dành Cho iPhone & iPad)

### Bước 3.1: Chuẩn bị tài khoản Apple Developer
1. Đăng ký tài khoản tại [Apple Developer Program](https://developer.apple.com) (\$99/năm).
2. Kích hoạt xác thực 2 yếu tố (2FA) trên tài khoản Apple ID.

### Bước 3.2: Đồng bộ và mở dự án trên Xcode
1. Mở terminal:
   ```bash
   cd mobile-app
   npx cap sync ios
   npx cap open ios
   ```
2. Xcode sẽ khởi động mở workspace `App.xcworkspace`.

### Bước 3.3: Cấu hình Ký số (Signing & Capabilities)
1. Trong Xcode, chọn project `App` ở cột bên trái > Chọn tab **Signing & Capabilities**.
2. Chọn **Team** của tài khoản Apple Developer của bạn.
3. Bundle Identifier: `com.gaeru.store`.
4. Bấm `+ Capability` và thêm:
   - **Associated Domains**: Thêm `applinks:gaeru.com` và `webcredentials:gaeru.com`.
   - **Push Notifications**: Bật tính năng nhận thông báo đẩy.

### Bước 3.4: Archive và Phân phối (Distribute App)
1. Chọn thiết bị đích là **Any iOS Device (arm64)**.
2. Vào menu **Product** > **Archive**.
3. Khi quá trình build hoàn tất, cửa sổ Organizer sẽ xuất hiện > Bấm **Distribute App** > Chọn **App Store Connect** > Bấm **Upload**.

### Bước 3.5: Cấu hình trên App Store Connect & Gửi duyệt
1. Truy cập [App Store Connect](https://appstoreconnect.apple.com).
2. Tạo App mới với Bundle ID `com.gaeru.store`.
3. Tải lên ảnh chụp màn hình iPhone (6.7" và 6.5").
4. Điền URL chính sách quyền riêng tư: `https://gaeru.com/privacy.html`.
5. Chọn bản build vừa tải lên từ Xcode.
6. Bấm **Submit for Review** (Gửi để Apple duyệt, thường từ 24h - 48h).

---

## 4. Tải Trực Tiếp File APK Cho Android (Không Cần Qua CH Play)

Để người dùng có thể tải ngay file cài đặt về điện thoại Android trực tiếp từ website:
1. Trong Android Studio, chọn **Build** > **Generate Signed Bundle / APK** > Chọn **APK** > Bấm **release**.
2. Đổi tên file APK xuất ra thành: `gaeru-store.apk`.
3. Đặt file vào thư mục: `public/downloads/gaeru-store.apk` trên server website.
4. Khách hàng truy cập trang `https://gaeru.com/tai-app` và bấm nút **"Tải trực tiếp File APK"** để cài đặt ngay.
