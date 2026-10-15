# MoMo Payment Node.js Example

Ví dụ tích hợp thanh toán MoMo Sandbox bằng Node.js, Express, EJS và package
[`momo-payment`](https://www.npmjs.com/package/momo-payment).

Ứng dụng minh họa đầy đủ một luồng thanh toán:

- tạo payment request;
- chuyển người dùng sang cổng thanh toán MoMo;
- nhận kết quả qua `redirectUrl`;
- nhận kết quả bất đồng bộ qua `ipnUrl`;
- kiểm tra chữ ký IPN;
- kiểm tra `partnerCode`, `orderId` và `amount`;
- xử lý idempotency trong phạm vi phiên chạy;
- query lại trạng thái giao dịch từ MoMo;
- hiển thị giao dịch và payload JSON trên giao diện demo;
- expose localhost bằng HTTPS qua `localhost.run`, không cần tài khoản hoặc
  authtoken.

> **Lưu ý:** Đây là project demo. Giao dịch hiện chỉ được lưu trong `Map` trên
> RAM, vì vậy dữ liệu sẽ mất khi restart app. Ứng dụng production cần database,
> transaction và idempotency key bền vững.

## 1. Kiến trúc luồng thanh toán

```text
Browser
   |
   | POST /payments/momo/create
   v
Express application
   |
   | POST /v2/gateway/api/create
   v
MoMo Sandbox
   |
   | redirectUrl (GET)
   +------------------------------> /payments/momo/return
   |
   | ipnUrl (POST JSON)
   +------------------------------> /payments/momo/ipn
                                      |
                                      | verify signature,
                                      | verify amount/order
                                      v
                                Update transaction
                                      |
                                      | HTTP 204
                                      v
                                  MoMo Sandbox
```

## 2. Yêu cầu môi trường

- Node.js 18 trở lên.
- npm.
- Windows 10/11 có OpenSSH Client để chạy `localhost.run`.
- Tài khoản MoMo Sandbox và thông tin tích hợp:
  - `MOMO_PARTNER_CODE`;
  - `MOMO_ACCESS_KEY`;
  - `MOMO_SECRET_KEY`.

Kiểm tra Node.js và SSH:

```powershell
node --version
npm.cmd --version
ssh -V
```

## 3. Cài đặt

Mở PowerShell tại thư mục project:

```powershell
cd "C:\Users\peter\Downloads\MoMo NodeJS"
npm.cmd install
Copy-Item .env.example .env
```

Mở `.env` và điền credentials MoMo Sandbox. Không commit file `.env`.

## 4. Cấu hình `.env`

```env
PORT=3000

MOMO_PARTNER_CODE=MOMxxxx_TEST
MOMO_ACCESS_KEY=your-sandbox-access-key
MOMO_SECRET_KEY=your-sandbox-secret-key

# Chỉ dùng base URL; SDK tự nối /v2/gateway/api/create và /query.
MOMO_ENDPOINT=https://test-payment.momo.vn

# true: tự tạo HTTPS URL bằng localhost.run.
# false: chỉ chạy local, phù hợp khi không cần IPN từ MoMo.
TUNNEL_ENABLED=true

# Để trống khi dùng localhost.run.
# Có thể đặt URL public cố định nếu đã có domain HTTPS riêng.
APP_BASE_URL=

# true để xem log request, callback và IPN; false để giảm log.
MOMO_DEBUG=true
```

### Endpoint Sandbox và Production

Mặc định project dùng:

```text
https://test-payment.momo.vn
```

Không thêm `/v2/gateway/api` vào `MOMO_ENDPOINT`; thư viện tự nối path API.
Chỉ chuyển sang endpoint Production khi đã có credentials Production và đã
kiểm tra đầy đủ cấu hình.

## 5. Chạy ứng dụng

Chạy development mode:

```powershell
npm.cmd run dev
```

Hoặc chạy trực tiếp:

```powershell
node .
```

Khi tunnel khởi động thành công, terminal sẽ hiển thị URL tương tự:

```text
MoMo example listening at http://localhost:3000
localhost.run connected {
  publicBaseUrl: 'https://5e0d6f77bd1a44.lhr.life'
}
Public callback base URL: https://5e0d6f77bd1a44.lhr.life
IPN URL: https://5e0d6f77bd1a44.lhr.life/payments/momo/ipn
```

URL này được dùng tự động trong payment request:

```text
redirectUrl = https://<public-host>/payments/momo/return
ipnUrl      = https://<public-host>/payments/momo/ipn
```

Mỗi lần restart app, `localhost.run` có thể cấp URL mới. Hãy tạo payment sau
khi thấy dòng `IPN URL` mới trong terminal.

### Kiểm tra URL public

```powershell
Invoke-WebRequest `
  -Uri "https://<public-host>/health" `
  -UseBasicParsing
```

Kết quả mong đợi:

```json
{
  "ok": true,
  "service": "momo-payment-nodejs-example",
  "publicBaseUrl": "https://<public-host>",
  "ipnUrl": "https://<public-host>/payments/momo/ipn"
}
```

## 6. Sử dụng giao diện demo

Mở:

```text
http://localhost:3000
```

Nhập số tiền và nội dung, sau đó chọn **Tạo payment và mở MoMo**.

![Trang tạo thanh toán MoMo](<images/Homepage.png>)

Giao diện hiển thị:

- TMN code;
- môi trường Sandbox/Production;
- callback base URL hiện tại;
- form tạo payment;
- danh sách giao dịch trong phiên;
- trạng thái giao dịch;
- nút query transaction;
- nút xem JSON transaction.

## 7. Thanh toán trên cổng MoMo

Sau khi tạo payment, server gọi API create của MoMo và redirect trình duyệt tới
`payUrl`.

![Màn hình thanh toán MoMo Sandbox](<images/MoMo pay.png>)

Ở màn hình MoMo Sandbox, người dùng có thể quét QR hoặc dùng ứng dụng MoMo
Sandbox để xác nhận hoặc từ chối giao dịch.

## 8. Kết quả thanh toán và IPN

MoMo gửi hai loại callback:

### 8.1. Redirect callback

Sau khi người dùng hoàn tất hoặc hủy thanh toán, MoMo chuyển hướng trình duyệt
đến:

```text
GET /payments/momo/return
```

Handler lưu payload vào transaction và hiển thị trang kết quả. Redirect phù hợp
để cập nhật giao diện cho người dùng, nhưng không nên là nguồn duy nhất để xác
nhận đã nhận tiền vì người dùng có thể đóng trình duyệt.

### 8.2. Instant Payment Notification (IPN)

MoMo gọi server-to-server:

```text
POST /payments/momo/ipn
Content-Type: application/json
```

Handler IPN thực hiện:

1. kiểm tra payload JSON;
2. kiểm tra `partnerCode`;
3. kiểm tra chữ ký HMAC-SHA256;
4. tìm `orderId` trong transaction;
5. đối chiếu `amount`;
6. cập nhật `resultCode`, `message`, `transId` và trạng thái;
7. phản hồi `HTTP 204 No Content`.

MoMo yêu cầu đối tác phản hồi trong vòng 15 giây. Endpoint IPN không trả JSON
thành công mà trả body rỗng với status `204`.

Ví dụ log IPN thành công:

```text
[momo-example] MoMo IPN received {
  contentType: 'application/json',
  signature: { hasSignature: true, signatureLength: 64 },
  payload: {
    partnerCode: 'MOMOLI4O20260908_TEST',
    orderId: 'DEMO_1792029194613_OE24PB',
    requestId: 'DEMO_1792029194613_OE24PB',
    amount: 1000,
    resultCode: 0,
    message: 'Thành công.'
  }
}

[momo-example] MoMo IPN processed {
  orderId: 'DEMO_1792029194613_OE24PB',
  resultCode: 0,
  status: 'SUCCESS'
}

HTTP request {
  method: 'POST',
  path: '/payments/momo/ipn',
  status: 204
}
```

Log chỉ hiển thị `hasSignature` và độ dài chữ ký, không hiển thị secret key
hoặc toàn bộ chữ ký.

## 9. Trạng thái giao dịch

Project ánh xạ các result code chính như sau:

| `resultCode` | Trạng thái demo | Ý nghĩa |
| ---: | --- | --- |
| `0` | `SUCCESS` | Thanh toán thành công |
| `9000` | `AUTHORIZED` | Đã authorization; cần capture/cancel tùy loại payment |
| `1000` | `PENDING` | Đang chờ người dùng xác nhận |
| `7000` | `PENDING` | Giao dịch đang được xử lý |
| `7002` | `PENDING` | Đang được nhà cung cấp phương thức thanh toán xử lý |
| `1003` | `FAILED` | Giao dịch bị hủy |
| `1004` | `FAILED` | Vượt hạn mức thanh toán |
| `1005` | `FAILED` | URL hoặc QR đã hết hạn |
| `1006` | `FAILED` | Người dùng từ chối thanh toán |
| `1007` | `FAILED` | Tài khoản không tồn tại hoặc không hoạt động |
| mã khác `0` | `FAILED` | Thanh toán thất bại hoặc lỗi hệ thống |

Ví dụ giao dịch thất bại do người dùng từ chối:

```text
resultCode: 1006
message: 'Giao dịch bị từ chối bởi người dùng.'
status: 'FAILED'
```

## 10. Query transaction

Trong danh sách giao dịch, bấm **Query txn** để gọi:

```text
POST /transactions/:orderId/query
```

Server tạo `requestId` riêng:

```text
QUERY_<orderId>
```

Sau đó gọi MoMo Query API và cập nhật transaction theo kết quả trả về.

![Danh sách giao dịch thành công](<images/MoMo transactions.png>)

Kết quả query thành công được hiển thị bằng thông báo:

```text
Query <orderId>: Thành công.
```

## 11. Xem chi tiết transaction

Chọn nút **JSON** trong danh sách giao dịch hoặc gọi:

```text
GET /api/transactions/:orderId
```

Payload gồm thông tin local transaction, create response, return payload, IPN
payload và query payload nếu đã thực hiện.

![Chi tiết transaction dạng JSON](<images/MoMo txn detailed.png>)

Trong ảnh, transaction có:

- `status: "SUCCESS"`;
- `amount: 1000`;
- `resultCode: "0"` từ redirect;
- `resultCode: 0` từ query;
- `transId` do MoMo cấp;
- `payUrl`;
- `returnPayload`;
- `queryPayload`.

## 12. Kết quả trên ứng dụng MoMo

Khi giao dịch Sandbox thành công, ứng dụng MoMo hiển thị mã giao dịch và số
tiền đã thanh toán.

![Kết quả giao dịch thành công trên ứng dụng MoMo](<images/MoMo user success.jpg>)

## 13. API routes

| Method | Route | Mục đích |
| --- | --- | --- |
| `GET` | `/` | Giao diện demo |
| `POST` | `/payments/momo/create` | Tạo payment và redirect tới MoMo |
| `GET` | `/payments/momo/return` | Nhận redirect callback |
| `POST` | `/payments/momo/ipn` | Nhận IPN server-to-server |
| `POST` | `/transactions/:orderId/query` | Query trạng thái từ MoMo |
| `GET` | `/api/transactions/:orderId` | Xem transaction dạng JSON |
| `GET` | `/health` | Kiểm tra app và callback URL |

## 14. Idempotency và bảo mật

MoMo hỗ trợ idempotency cho POST request thông qua `requestId`. Trong project:

- request create dùng `orderId` làm `requestId` mặc định;
- query dùng `QUERY_<orderId>`;
- order ID được tạo mới cho mỗi payment;
- IPN được kiểm tra chữ ký trước khi cập nhật dữ liệu;
- `partnerCode`, `orderId` và `amount` được đối chiếu;
- trạng thái cuối (`SUCCESS`, `FAILED`, `AUTHORIZED`) không bị IPN lặp lại ghi
  đè;
- không log `MOMO_SECRET_KEY`;
- không commit `.env`.

Trong production, cần thay `Map` bằng database và dùng unique constraint trên
`orderId`/`requestId`. Việc cập nhật trạng thái và ghi nhận side effect như xuất
đơn hàng, cộng điểm hoặc giao hàng phải nằm trong transaction hoặc có cơ chế
deduplication riêng.

## 15. Troubleshooting

### Không có IPN

Kiểm tra lần lượt:

1. URL trong terminal có phải URL mới nhất không?
2. `/health` có truy cập được từ Internet không?
3. `TUNNEL_ENABLED=true` chưa?
4. OpenSSH có hoạt động không (`ssh -V`)?
5. Payment được tạo sau khi tunnel đã in ra `IPN URL` chưa?
6. Log có dòng `MoMo IPN received` không?

Nếu localhost.run không cấp URL, chạy:

```powershell
TUNNEL_ENABLED=false
```

hoặc đặt `APP_BASE_URL` bằng một HTTPS URL public khác.

### `Missing MoMo signature`

Payload IPN không có trường `signature`. Kiểm tra endpoint, môi trường MoMo và
payload request thực tế.

### `Invalid MoMo signature`

Payload có chữ ký nhưng không khớp. Kiểm tra:

- `MOMO_PARTNER_CODE`;
- `MOMO_ACCESS_KEY`;
- `MOMO_SECRET_KEY`;
- `MOMO_ENDPOINT`;
- credentials Sandbox/Production có bị trộn hay không.

### IPN trả lỗi `400`

Kiểm tra log cụ thể:

- `Partner code mismatch`;
- `Missing MoMo signature`;
- `Invalid MoMo signature`;
- `Unknown orderId`;
- `Amount mismatch`.

### Port 3000 đã được sử dụng

Đổi port trong `.env`:

```env
PORT=3100
```

Khi đó localhost.run sẽ forward tới port mới.

## 16. Tắt debug log

Để giảm log:

```env
MOMO_DEBUG=false
```

Khi debug bị tắt, các log request chi tiết sẽ không được ghi. Các lỗi quan trọng
như create payment thất bại hoặc tunnel không khởi động vẫn được ghi ra console.

## 17. Scripts

```powershell
npm.cmd run dev
npm.cmd start
```

- `npm.cmd run dev`: chạy Node.js watch mode.
- `npm.cmd start`: chạy server bình thường.

## 18. License

Project demo phục vụ mục đích học tập và thử nghiệm tích hợp MoMo Sandbox.
