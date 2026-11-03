/**
 * AWS Services integration (S3 + SES)
 *
 * Re-exports AWS utilities from @be-yours/core
 * for file storage and email functionality.
 *
 * @example
 * ```ts
 * // S3 Usage
 * import { createS3Service } from '@/lib/aws'
 *
 * const s3 = createS3Service(config, s3Client)
 * const { url } = await s3.upload(file, { folder: 'products', contentType: file.type })
 *
 * // SES Usage
 * import { createSESService } from '@/lib/aws'
 *
 * const ses = createSESService(config, sesClient)
 * await ses.sendEmail({ to: 'user@example.com', subject: 'Hello', html: '<p>Hi!</p>' })
 * ```
 */

// ============================================================================
// Types
// ============================================================================
export type {
  AWSConfig,
  S3Config,
  SESConfig,
  S3Folder,
} from '@be-yours/core'

export {
  ALLOWED_MIME_TYPES,
  MAX_FILE_SIZES,
  S3_FOLDERS,
  PRIVATE_S3_FOLDERS,
  isKnownS3Folder,
  isPrivateS3Folder,
} from '@be-yours/core'

// ============================================================================
// Media URL policy (private bucket — see aws/media-url)
// ============================================================================
export {
  MEDIA_PROXY_PATH,
  buildMediaUrl,
  mediaKeyFromUrl,
} from '@be-yours/core'

// ============================================================================
// S3 Service
// ============================================================================
export type {
  S3Service,
  S3Operations,
  UploadOptions,
  UploadResult,
  PresignedUploadOptions,
  PresignedUploadResult,
  PresignedDownloadResult,
  ObjectMetadata,
  PutObjectParams,
  DeleteObjectParams,
  GetSignedUrlParams,
  HeadObjectParams,
  // The version half of the adapter. `setup-aws.sh` turns bucket versioning ON,
  // and on a versioned bucket a DeleteObject with no VersionId deletes nothing:
  // it writes a delete marker and keeps every prior version, billed and
  // readable by anyone who can name a version id. An `S3Operations` adapter
  // therefore has to implement `listObjectVersions` and `deleteObjectVersion`
  // to make `S3Service.delete` an actual deletion — and these are the names it
  // needs to do that. Without them re-exported here, an app could not so much
  // as spell the parameter types. `DeleteResult` is what `delete()` answers:
  // only `outcome: 'purged'` means the bytes are gone.
  ObjectVersion,
  ListObjectVersionsParams,
  ListObjectVersionsResult,
  DeleteObjectVersionParams,
  DeleteResult,
} from '@be-yours/core'

export {
  createS3Service,
  validateMimeType,
  validateFileSize,
  getExtensionFromMimeType,
} from '@be-yours/core'

// ============================================================================
// SES Service
// ============================================================================
export type {
  SESService,
  SendEmailParams,
  SendEmailResult,
  SendTemplatedEmailParams,
  SendBulkEmailParams,
  SendBulkEmailResult,
  SESOperations,
} from '@be-yours/core'

export {
  createSESService,
} from '@be-yours/core'

// ============================================================================
// Email Templates
// ============================================================================
export type {
  EmailTemplate,
  OrderConfirmationData,
  SESPasswordResetData,
  WelcomeData,
  PrizeWonData,
  TemplateName,
} from '@be-yours/core'

export {
  orderConfirmationTemplate,
  passwordResetTemplate,
  welcomeTemplate,
  prizeWonTemplate,
  sesEmailTemplates,
  getTemplate,
} from '@be-yours/core'
