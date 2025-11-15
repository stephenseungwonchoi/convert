import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import JSZip from 'jszip'
import { encode as encodeAvif } from '@jsquash/avif'
import { encode as encodeWebp } from '@jsquash/webp'
import { init as initAvifCodec } from '@jsquash/avif/encode'
import { init as initWebpCodec } from '@jsquash/webp/encode'
import avifMtWasmUrl from '@jsquash/avif/codec/enc/avif_enc_mt.wasm?url'
import avifSingleWasmUrl from '@jsquash/avif/codec/enc/avif_enc.wasm?url'
import avifWorkerUrl from '@jsquash/avif/codec/enc/avif_enc_mt.worker.mjs?url'
import webpWasmUrl from '@jsquash/webp/codec/enc/webp_enc.wasm?url'
import webpSimdWasmUrl from '@jsquash/webp/codec/enc/webp_enc_simd.wasm?url'
import './App.css'

type SourceType = 'image/jpeg' | 'image/png'
type TargetType = 'image/avif' | 'image/webp'
type ConversionStatus = 'pending' | 'processing' | 'done' | 'error'

type ConversionJob = {
  id: string
  file: File
  sourceType: SourceType
  targetType: TargetType
  status: ConversionStatus
  progress: number
  error?: string
  blob?: Blob
  downloadName?: string
}

const TARGET_BY_SOURCE: Record<SourceType, { target: TargetType; extension: string; label: string }> = {
  'image/jpeg': { target: 'image/avif', extension: 'avif', label: 'AVIF' },
  'image/png': { target: 'image/webp', extension: 'webp', label: 'WebP' },
}

const buildLocateFile = (mapping: Record<string, string>) => {
  const entries = Object.entries(mapping)
  return (path: string) => {
    const match = entries.find(([suffix]) => path.endsWith(suffix))
    return match ? match[1] : path
  }
}

const AVIF_LOCATE_FILE = buildLocateFile({
  'avif_enc_mt.wasm': avifMtWasmUrl,
  'avif_enc.wasm': avifSingleWasmUrl,
  'avif_enc_mt.worker.mjs': avifWorkerUrl,
})

const WEBP_LOCATE_FILE = buildLocateFile({
  'webp_enc_simd.wasm': webpSimdWasmUrl,
  'webp_enc.wasm': webpWasmUrl,
})

const createJobId = () => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }

  return Math.random().toString(36).slice(2)
}

const resolveSourceType = (file: File): SourceType | null => {
  if (file.type === 'image/jpeg' || file.type === 'image/pjpeg') return 'image/jpeg'
  if (file.type === 'image/png') return 'image/png'

  const extension = file.name.split('.').pop()?.toLowerCase()
  if (extension && ['jpg', 'jpeg'].includes(extension)) return 'image/jpeg'
  if (extension === 'png') return 'image/png'

  return null
}

const buildOutputName = (filename: string, extension: string) => {
  const base = filename.replace(/\.[^/.]+$/, '') || 'converted'
  return `${base}.${extension}`
}

const triggerDownload = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

type DrawingContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

const createDrawingContext = (width: number, height: number): DrawingContext => {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' })
    if (!context) {
      throw new Error('이미지를 처리할 수 없어요.')
    }
    return context
  }

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' })
  if (!context) {
    throw new Error('이미지를 처리할 수 없어요.')
  }
  return context
}

const loadImageElement = (file: File) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const image = new Image()
    image.decoding = 'async'
    image.onload = () => {
      URL.revokeObjectURL(url)
      resolve(image)
    }
    image.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('이미지를 불러오지 못했어요.'))
    }
    image.src = url
  })

const readImageData = async (file: File) => {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(file, {
      colorSpaceConversion: 'default',
      premultiplyAlpha: 'none',
    })
    const context = createDrawingContext(bitmap.width, bitmap.height)
    context.drawImage(bitmap, 0, 0)
    const imageData = context.getImageData(0, 0, bitmap.width, bitmap.height)
    bitmap.close()
    return imageData
  }

  const image = await loadImageElement(file)
  const width = image.naturalWidth || image.width
  const height = image.naturalHeight || image.height
  const context = createDrawingContext(width, height)
  context.drawImage(image, 0, 0, width, height)
  return context.getImageData(0, 0, width, height)
}

function App() {
  const [jobs, setJobs] = useState<ConversionJob[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const [avifQuality, setAvifQuality] = useState(60)
  const [webpQuality, setWebpQuality] = useState(75)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const codecInitRef = useRef<Promise<void> | null>(null)

  const updateJob = useCallback((id: string, patch: Partial<ConversionJob>) => {
    setJobs((prev) => prev.map((job) => (job.id === id ? { ...job, ...patch } : job)))
  }, [])

  const ensureCodecsReady = useCallback(() => {
    if (!codecInitRef.current) {
      codecInitRef.current = (async () => {
        await Promise.all([
          initAvifCodec({ locateFile: AVIF_LOCATE_FILE }),
          initWebpCodec({ locateFile: WEBP_LOCATE_FILE }),
        ])
      })()
    }
    return codecInitRef.current
  }, [])

  const runConversion = useCallback(
    async (job: ConversionJob) => {
      updateJob(job.id, { status: 'processing', progress: 10, error: undefined })

      try {
        await ensureCodecsReady()
        updateJob(job.id, { progress: 35 })
        const imageData = await readImageData(job.file)

        updateJob(job.id, { progress: 65 })

        const encodedBuffer =
          job.targetType === 'image/avif'
            ? await encodeAvif(imageData, {
                quality: avifQuality,
                enableSharpYUV: true,
                chromaDeltaQ: true,
                speed: 6,
              })
            : await encodeWebp(imageData, {
                quality: webpQuality,
                method: 6,
                alpha_quality: 90,
                use_sharp_yuv: 1,
              })

        const blob = new Blob([encodedBuffer], { type: job.targetType })
        const { extension } = TARGET_BY_SOURCE[job.sourceType]
        const downloadName = buildOutputName(job.file.name, extension)

        updateJob(job.id, { status: 'done', blob, downloadName, progress: 100 })
      } catch (error) {
        const message = error instanceof Error ? error.message : '예상하지 못한 오류가 발생했어요.'
        updateJob(job.id, { status: 'error', error: message })
      }
    },
    [avifQuality, ensureCodecsReady, updateJob, webpQuality],
  )

  useEffect(() => {
    jobs.filter((job) => job.status === 'pending').forEach((job) => {
      runConversion(job)
    })
  }, [jobs, runConversion])

  const addFiles = useCallback((files: FileList | File[]) => {
    const additions: ConversionJob[] = []

    Array.from(files).forEach((file) => {
      const sourceType = resolveSourceType(file)
      if (!sourceType) {
        return
      }

      const { target } = TARGET_BY_SOURCE[sourceType]
      additions.push({
        id: createJobId(),
        file,
        sourceType,
        targetType: target,
        status: 'pending',
        progress: 0,
      })
    })

    if (additions.length === 0) {
      return
    }

    setJobs((prev) => [...prev, ...additions])
  }, [])

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setIsDragging(false)
    if (event.dataTransfer.files?.length) {
      addFiles(event.dataTransfer.files)
    }
  }

  const handleBrowse = () => {
    fileInputRef.current?.click()
  }

  const finishedJobs = useMemo(() => jobs.filter((job) => job.status === 'done' && job.blob), [jobs])
  const activeJobs = useMemo(() => jobs.filter((job) => job.status === 'processing' || job.status === 'pending'), [jobs])

  const handleDownloadSingle = (job: ConversionJob) => {
    if (!job.blob || !job.downloadName) return
    triggerDownload(job.blob, job.downloadName)
  }

  const handleDownloadArchive = async () => {
    if (!finishedJobs.length) return

    const zip = new JSZip()
    finishedJobs.forEach((job) => {
      if (job.blob && job.downloadName) {
        zip.file(job.downloadName, job.blob)
      }
    })

    const archive = await zip.generateAsync({ type: 'blob' })
    triggerDownload(archive, `converted-${new Date().getTime()}.zip`)
  }

  const handleClear = () => setJobs([])

  return (
    <main className="app-shell">
      <header className="hero">
        <div className="hero-metrics">
          <div>
            <p className="metric-title">완료</p>
            <p className="metric-value">{finishedJobs.length}</p>
          </div>
          <div>
            <p className="metric-title">대기/처리</p>
            <p className="metric-value">{activeJobs.length}</p>
          </div>
        </div>
      </header>

      <section className="uploader">
        <div
          className={`dropzone ${isDragging ? 'is-dragging' : ''}`}
          onDragOver={(event) => {
            event.preventDefault()
            setIsDragging(true)
          }}
          onDragLeave={(event) => {
            event.preventDefault()
            setIsDragging(false)
          }}
          onDrop={handleDrop}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg"
            multiple
            hidden
            onChange={(event) => {
              if (event.target.files?.length) {
                addFiles(event.target.files)
                event.target.value = ''
              }
            }}
          />
          <p className="dropzone-title">여러 장을 드래그하거나 클릭해서 선택하세요</p>
          <p className="dropzone-subtitle">JPEG → AVIF, PNG → WebP</p>
          <div className="dropzone-buttons">
            <button type="button" onClick={handleBrowse}>
              파일 선택
            </button>
            <span>또는 바로 드롭</span>
          </div>
          <p className="dropzone-note">서버 업로드 없이 브라우저에서 즉시 변환합니다.</p>
        </div>

        <div className="quality-panel">
          <div>
            <label htmlFor="avif-quality">
              AVIF 품질 <span>{avifQuality}</span>
            </label>
            <input
              id="avif-quality"
              type="range"
              min={30}
              max={100}
              value={avifQuality}
              onChange={(event) => setAvifQuality(Number(event.target.value))}
            />
          </div>
          <div>
            <label htmlFor="webp-quality">
              WebP 품질 <span>{webpQuality}</span>
            </label>
            <input
              id="webp-quality"
              type="range"
              min={40}
              max={100}
              value={webpQuality}
              onChange={(event) => setWebpQuality(Number(event.target.value))}
            />
          </div>
        </div>
      </section>

      <section className="job-controls">
        <div>
          <strong>{jobs.length}</strong> 개의 파일이 큐에 있습니다.
        </div>
        <div className="control-buttons">
          <button type="button" onClick={handleDownloadArchive} disabled={!finishedJobs.length}>
            완료본 ZIP 다운로드
          </button>
          <button type="button" onClick={handleClear} disabled={!jobs.length}>
            목록 비우기
          </button>
        </div>
      </section>

      <section className="job-list">
        {jobs.length === 0 && <p className="empty">아직 변환한 파일이 없습니다. 이미지를 끌어와서 시작하세요.</p>}
        {jobs.map((job) => {
          const { label } = TARGET_BY_SOURCE[job.sourceType]
          const hint = job.sourceType === 'image/jpeg' ? 'JPEG → AVIF' : 'PNG → WebP'
          return (
            <article key={job.id} className={`job-card status-${job.status}`}>
              <div className="job-meta">
                <div>
                  <p className="job-name">{job.file.name}</p>
                  <p className="job-hint">{hint}</p>
                </div>
                <div className="job-status">
                  {job.status === 'processing' && <span>변환 중…</span>}
                  {job.status === 'pending' && <span>대기 중…</span>}
                  {job.status === 'done' && <span>{label} 완료</span>}
                  {job.status === 'error' && <span>실패</span>}
                </div>
              </div>

              <div className="progress">
                <div className="progress-bar" style={{ width: `${job.progress}%` }} />
              </div>

              {job.status === 'error' && <p className="job-error">{job.error}</p>}

              {job.status === 'done' && job.blob && job.downloadName && (
                <div className="job-actions">
                  <button type="button" onClick={() => handleDownloadSingle(job)}>
                    단일 다운로드
                  </button>
                </div>
              )}
            </article>
          )
        })}
      </section>
    </main>
  )
}

export default App
