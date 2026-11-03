/**
 * Browser-to-S3 upload with progress tracking.
 *
 * Uses XMLHttpRequest (instead of fetch) because fetch does not expose
 * upload progress events.
 */

export interface UploadProgressEvent {
  /** 0–100 */
  percent: number
  loaded: number
  total: number
}

interface UploadWithProgressOptions {
  url: string
  body: Blob | File
  contentType: string
  onProgress?: (event: UploadProgressEvent) => void
  /** AbortSignal to cancel the upload */
  signal?: AbortSignal
}

export function uploadWithProgress({
  url,
  body,
  contentType,
  onProgress,
  signal,
}: UploadWithProgressOptions): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest()

    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress({
          percent: Math.round((e.loaded / e.total) * 100),
          loaded: e.loaded,
          total: e.total,
        })
      }
    })

    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve()
      } else {
        reject(new Error(`Upload échoué (${xhr.status})`))
      }
    })

    xhr.addEventListener("error", () => {
      reject(new Error("Erreur réseau pendant l'upload"))
    })

    xhr.addEventListener("abort", () => {
      reject(new Error("Upload annulé"))
    })

    if (signal) {
      signal.addEventListener("abort", () => xhr.abort(), { once: true })
    }

    xhr.open("PUT", url)
    xhr.setRequestHeader("Content-Type", contentType)
    xhr.send(body)
  })
}
