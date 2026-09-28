# Authentication setup

The verified authentication server reads configuration from environment variables.

## Google Identity Services

Create a Web application OAuth client in Google Cloud, then add these authorized JavaScript origins while developing:

- `http://localhost:3100`

Set:

```powershell
$env:GOOGLE_CLIENT_ID = "your-client-id.apps.googleusercontent.com"
```

## Verification email with Resend

Create a Resend API key and verify the domain used in the sender address. Set:

```powershell
$env:RESEND_API_KEY = "re_your_api_key"
$env:EMAIL_FROM = "Nearby <verify@your-domain.example>"
$env:APP_ORIGIN = "http://localhost:3100"
```

Then launch:

```powershell
node server-auth.js
```

For production, set `APP_ORIGIN` to the public HTTPS origin and add that origin to the Google OAuth client.
