/** Generates the HTML template for email verification messages */
export function verificationEmailHtml(verificationCode: string): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Buddy Email Verification</title>
</head>
<body style="margin:0; padding:0; background-color:#eef2f7; font-family:Arial, Helvetica, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background-color:#eef2f7; padding:24px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" role="presentation" style="background-color:#ffffff; border-radius:14px; overflow:hidden; box-shadow:0 10px 25px rgba(0,0,0,0.05);">
          
          <!-- Header -->
          <tr>
            <td style="padding:28px; text-align:center; background-color:#f42e2e;">
              <h1 style="margin:0; font-size:24px; color:#ffffff;">
                🐶 Buddy
              </h1>
              <p style="margin:8px 0 0 0; font-size:14px; color:#dbeafe;">
                Verification code
              </p>
            </td>
          </tr>

          <!-- Content -->
          <tr>
            <td style="padding:36px; color:#111827;">
              <p style="margin:0 0 20px 0; font-size:16px; line-height:1.6;">
                Enter this code to verify your account:
              </p>

              <div style="margin:32px 0; text-align:center;">
                <span style="
                  display:inline-block;
                  font-size:30px;
                  letter-spacing:6px;
                  font-weight:700;
                  padding:18px 26px;
                  border-radius:10px;
                  color:black;
                  border:2px dashed #f42e2e;
                ">
                  ${verificationCode}
                </span>
              </div>

              <p style="margin:0 0 16px 0; font-size:14px; line-height:1.6; color:#374151;">
                Code expires soon. Didn't request this? Ignore it.
              </p>

              <p style="margin:0; font-size:14px; color:#6b7280;">
                Buddy Team
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color:#f8fafc; padding:18px; text-align:center; font-size:12px; color:#9ca3af;">
              © ${new Date().getFullYear()} Buddy
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`;
}
