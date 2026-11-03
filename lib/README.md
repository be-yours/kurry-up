# Restaurant Theme - Core Package Integration

This directory contains integration files that re-export utilities from `@be-yours/core` package.

## Files

### `rbac.ts` - Role-Based Access Control
Re-exports authentication and RBAC utilities for permission management.

**Usage:**
```typescript
import { Role, hasPermission, requireAuth } from '@/lib/rbac'

// Check permissions
const canEdit = hasPermission(user.role, 'products:write')

// In server components/API routes
const user = await requireAuth()
const hasAccess = await requireRestaurantAccess(user, restaurantId)
```

**Exports:**
- Enums: `Role`, `Resource`, `Action`
- Types: `Permission`, `AuthUser`, `AuthSession`, `AuthSessionData`
- Functions: `hasPermission`, `requireAuth`, `requireRole`, etc.
- Errors: `UnauthorizedError`, `ForbiddenError`, `PermissionDeniedError`

---

### `i18n.ts` - Internationalization
Re-exports i18n utilities for multi-language support with GPT auto-translation.

**Usage:**
```typescript
import { detectLocale, createTranslator, translateText } from '@/lib/i18n'

// Detect user's language
const locale = detectLocale({ supportedLocales: ['en', 'fr', 'es'] })

// Create translator
const t = createTranslator(locale, translations)

// GPT translation (admin feature)
const translated = await translateText('Hello', 'en', 'fr', 'greeting')
```

**Exports:**
- Types: `Locale`, `TranslationMap`, `I18nConfig`, etc.
- Detection: `detectLocale`, `detectLocaleFromCookie`, `detectLocaleFromBrowser`
- Storage: `setLocale`, `clearLocale`, `getLocaleFromCookie`
- Translation: `createTranslator`, `translateText`, `batchTranslate`
- Config: `DEFAULT_I18N_CONFIG`, `COMMON_LANGUAGES`, `RTL_LANGUAGES`

---

### `aws.ts` - AWS Services (S3 + SES)
Re-exports AWS S3 and SES utilities for file storage and email.

**Usage:**
```typescript
// S3 - File Upload
import { createS3Service, type UploadOptions } from '@/lib/aws'

const s3 = createS3Service(config, s3Client)
const result = await s3.upload(fileBuffer, {
  folder: 'products',
  contentType: 'image/jpeg',
})

// SES - Email
import { createSESService, sesEmailTemplates } from '@/lib/aws'

const ses = createSESService(config, sesClient)
await ses.sendTemplatedEmail({
  to: 'user@example.com',
  templateName: 'orderConfirmation',
  templateData: { orderNumber: '123', ... },
})
```

**Exports:**
- S3: `createS3Service`, `validateMimeType`, `validateFileSize`
- SES: `createSESService`, `sesEmailTemplates`
- Types: `S3Config`, `SESConfig`, `UploadResult`, `EmailTemplate`
- Templates: `orderConfirmationTemplate`, `passwordResetTemplate`, `welcomeTemplate`, `prizeWonTemplate`

---

### `auth-client.ts` - Better Auth Client
Better Auth client configuration with Convex adapter.

**Usage:**
```typescript
import { authClient } from '@/lib/auth-client'

// In React components
const { data: session } = authClient.useSession()
const { data: user } = authClient.useUser()
```

**Exports:**
- `authClient` - Configured Better Auth client instance
- Re-exported types: `Role`, `Permission`, `AuthUser`, `AuthSession`

---

## Package Structure

```
@be-yours/core/
├── auth/           # RBAC, Better Auth integration
├── i18n/           # Multi-language, GPT translation
├── aws/
│   ├── s3/         # File storage
│   └── ses/        # Email service
└── sentry/         # Error tracking config
```

## Testing

All core package functionality is tested with 158 unit tests in `/packages/core/__tests__/`.

Run tests:
```bash
cd ../../packages/core
pnpm test
```

## Notes

- The core package is built with `tsup` and generates ESM + CJS + TypeScript definitions
- All exports use TypeScript strict mode
- Zod validation is used for all inputs
- React and AWS SDKs are external dependencies (not bundled)
