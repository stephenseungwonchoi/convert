import { useCallback, useMemo, useRef, useState, type DragEvent } from 'react'
import JSZip from 'jszip'
import { encode as encodeAvif } from '@jsquash/avif'
import { encode as encodeWebp } from '@jsquash/webp'
import { decode as decodeJpeg } from '@jsquash/jpeg'
import { decode as decodePng } from '@jsquash/png'
import encodeJpeg, { init as initJpegEncoder } from '@jsquash/jpeg/encode'
import encodePng, { init as initPngEncoder } from '@jsquash/png/encode'
import { init as initAvifCodec } from '@jsquash/avif/encode'
import { init as initWebpCodec } from '@jsquash/webp/encode'
import { init as initJpeg } from '@jsquash/jpeg/decode'
import { init as initPng } from '@jsquash/png/decode'
import avifMtWasmUrl from '@jsquash/avif/codec/enc/avif_enc_mt.wasm?url'
import avifSingleWasmUrl from '@jsquash/avif/codec/enc/avif_enc.wasm?url'
import avifWorkerUrl from '@jsquash/avif/codec/enc/avif_enc_mt.worker.mjs?url'
import mozjpegDecWasmUrl from '@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm?url'
import mozjpegEncWasmUrl from '@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm?url'
import pngWasmUrl from '@jsquash/png/codec/pkg/squoosh_png_bg.wasm?url'
import webpWasmUrl from '@jsquash/webp/codec/enc/webp_enc.wasm?url'
import webpSimdWasmUrl from '@jsquash/webp/codec/enc/webp_enc_simd.wasm?url'
import './App.css'

type SourceType = 'image/jpeg' | 'image/png'
type TargetType = 'image/avif' | 'image/webp' | 'image/jpeg' | 'image/png' | 'image/tiff'
type ConversionStatus = 'pending' | 'processing' | 'done' | 'error'
type ColorProfile = 'srgb' | 'adobe-rgb' | 'unknown'
type WorkingColorProfile = Exclude<ColorProfile, 'unknown'>

type ConversionJob = {
  id: string
  file: File
  sourceType: SourceType
  targetType: TargetType
  targetColorSpace: WorkingColorProfile
  targetQuality: number
  shortEdge?: number | null
  status: ConversionStatus
  progress: number
  error?: string
  blob?: Blob
  downloadName?: string
  sourceProfile?: ColorProfile
}

const FORMAT_OPTIONS: Array<{ value: TargetType; label: string; extension: string; supportsQuality: boolean }> = [
  { value: 'image/avif', label: 'AVIF', extension: 'avif', supportsQuality: true },
  { value: 'image/webp', label: 'WebP', extension: 'webp', supportsQuality: true },
  { value: 'image/jpeg', label: 'JPEG', extension: 'jpg', supportsQuality: true },
  { value: 'image/png', label: 'PNG', extension: 'png', supportsQuality: false },
  { value: 'image/tiff', label: 'TIFF', extension: 'tiff', supportsQuality: false },
]

const FORMAT_LOOKUP: Record<TargetType, { label: string; extension: string; supportsQuality: boolean }> = FORMAT_OPTIONS.reduce(
  (acc, option) => ({ ...acc, [option.value]: { label: option.label, extension: option.extension, supportsQuality: option.supportsQuality } }),
  {} as Record<TargetType, { label: string; extension: string; supportsQuality: boolean }>,
)

const COLOR_OPTIONS: Array<{ value: WorkingColorProfile; label: string }> = [
  { value: 'srgb', label: 'sRGB' },
  { value: 'adobe-rgb', label: 'Adobe RGB' },
]

const SOURCE_LABELS: Record<SourceType, string> = {
  'image/jpeg': 'JPEG',
  'image/png': 'PNG',
}

const buildLocateFile = (mapping: Record<string, string>) => {
  const entries = Object.entries(mapping)
  return (path: string) => {
    const sanitizedPath = path.split('?')[0]?.split('#')[0] ?? path
    const match = entries.find(([suffix]) => sanitizedPath.endsWith(suffix))
    return match ? match[1] : path
  }
}

const JPEG_DECODE_LOCATE_FILE = buildLocateFile({
  'mozjpeg_dec.wasm': mozjpegDecWasmUrl,
})

const JPEG_ENCODE_LOCATE_FILE = buildLocateFile({
  'mozjpeg_enc.wasm': mozjpegEncWasmUrl,
})

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

const clamp01 = (value: number) => Math.min(1, Math.max(0, value))

const srgbToLinear = (value: number) => {
  const c = clamp01(value)
  if (c <= 0.04045) return c / 12.92
  return Math.pow((c + 0.055) / 1.055, 2.4)
}

const linearToSrgb = (value: number) => {
  const c = clamp01(value)
  if (c <= 0.0031308) return c * 12.92
  return 1.055 * Math.pow(c, 1 / 2.4) - 0.055
}

const ADOBE_GAMMA = 563 / 256

const adobeRgbToLinear = (value: number) => Math.pow(clamp01(value), ADOBE_GAMMA)
const linearToAdobeRgb = (value: number) => Math.pow(clamp01(value), 1 / ADOBE_GAMMA)

const SRGB_TO_XYZ = [
  [0.4124564, 0.3575761, 0.1804375],
  [0.2126729, 0.7151522, 0.072175],
  [0.0193339, 0.119192, 0.9503041],
]

const XYZ_TO_SRGB = [
  [3.2406, -1.5372, -0.4986],
  [-0.9689, 1.8758, 0.0415],
  [0.0557, -0.204, 1.057],
]

const ADOBE_TO_XYZ = [
  [0.5767309, 0.185554, 0.1881852],
  [0.2973769, 0.6273491, 0.0752741],
  [0.0270343, 0.0706872, 0.9911085],
]

const XYZ_TO_ADOBE = [
  [2.041369, -0.5649464, -0.3446944],
  [-0.969266, 1.8760108, 0.041556],
  [0.0134474, -0.1183897, 1.0154096],
]

type ColorProfileConfig = {
  toLinear: (value: number) => number
  fromLinear: (value: number) => number
  rgbToXyz: number[][]
  xyzToRgb: number[][]
}

const COLOR_PROFILE_DEFINITIONS: Record<WorkingColorProfile, ColorProfileConfig> = {
  srgb: {
    toLinear: srgbToLinear,
    fromLinear: linearToSrgb,
    rgbToXyz: SRGB_TO_XYZ,
    xyzToRgb: XYZ_TO_SRGB,
  },
  'adobe-rgb': {
    toLinear: adobeRgbToLinear,
    fromLinear: linearToAdobeRgb,
    rgbToXyz: ADOBE_TO_XYZ,
    xyzToRgb: XYZ_TO_ADOBE,
  },
}

const multiplyMatrix = (matrix: number[][], vector: [number, number, number]) => {
  const [r, g, b] = vector
  return [
    matrix[0][0] * r + matrix[0][1] * g + matrix[0][2] * b,
    matrix[1][0] * r + matrix[1][1] * g + matrix[1][2] * b,
    matrix[2][0] * r + matrix[2][1] * g + matrix[2][2] * b,
  ] as [number, number, number]
}

const PROFILE_DECODER = new TextDecoder('latin1')

const detectJpegColorProfile = (buffer: ArrayBuffer): ColorProfile => {
  const bytes = new Uint8Array(buffer)
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return 'unknown'

  let offset = 2
  while (offset + 4 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1
      continue
    }

    const marker = bytes[offset + 1]
    offset += 2

    if (marker === 0xda || marker === 0xd9) break

    const length = (bytes[offset] << 8) | bytes[offset + 1]
    offset += 2

    if (length < 2 || offset + length - 2 > bytes.length) break

    if (marker === 0xe2) {
      const segment = bytes.subarray(offset, offset + length - 2)
      if (segment.length >= 14) {
        const identifier = PROFILE_DECODER.decode(segment.subarray(0, 11))
        if (identifier.startsWith('ICC_PROFILE')) {
          const payload = PROFILE_DECODER.decode(segment)
          if (/Adobe\s?RGB/i.test(payload)) return 'adobe-rgb'
          if (/sRGB/i.test(payload) || /IEC61966/i.test(payload)) return 'srgb'
        }
      }
    }

    offset += length - 2
  }

  return 'unknown'
}

const decodeSourceImage = async (sourceType: SourceType, buffer: ArrayBuffer) => {
  if (sourceType === 'image/jpeg') {
    const profile = detectJpegColorProfile(buffer)
    const imageData = await decodeJpeg(buffer)
    return { imageData, profile }
  }
  const imageData = await decodePng(buffer)
  return { imageData, profile: 'srgb' as ColorProfile }
}

const resolveWorkingProfile = (profile: ColorProfile): WorkingColorProfile =>
  profile === 'adobe-rgb' ? 'adobe-rgb' : 'srgb'

const convertColorSpace = (imageData: ImageData, fromProfile: WorkingColorProfile, toProfile: WorkingColorProfile) => {
  if (fromProfile === toProfile) return imageData

  const sourceConfig = COLOR_PROFILE_DEFINITIONS[fromProfile]
  const targetConfig = COLOR_PROFILE_DEFINITIONS[toProfile]
  const data = imageData.data

  for (let i = 0; i < data.length; i += 4) {
    const rLinear = sourceConfig.toLinear(data[i] / 255)
    const gLinear = sourceConfig.toLinear(data[i + 1] / 255)
    const bLinear = sourceConfig.toLinear(data[i + 2] / 255)

    const [x, y, z] = multiplyMatrix(sourceConfig.rgbToXyz, [rLinear, gLinear, bLinear])
    const [tr, tg, tb] = multiplyMatrix(targetConfig.xyzToRgb, [x, y, z])

    data[i] = Math.round(targetConfig.fromLinear(tr) * 255)
    data[i + 1] = Math.round(targetConfig.fromLinear(tg) * 255)
    data[i + 2] = Math.round(targetConfig.fromLinear(tb) * 255)
  }

  return imageData
}

type DrawingContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D
type CanvasSurface = {
  canvas: HTMLCanvasElement | OffscreenCanvas
  context: DrawingContext
}

const createSurface = (width: number, height: number): CanvasSurface => {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' })
    if (!context) throw new Error('이미지를 처리할 수 없어요.')
    return { canvas, context }
  }

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' })
  if (!context) throw new Error('이미지를 처리할 수 없어요.')
  return { canvas, context }
}

const surfaceFromImageData = (imageData: ImageData) => {
  const surface = createSurface(imageData.width, imageData.height)
  surface.context.putImageData(imageData, 0, 0)
  return surface
}

const resizeImageData = (imageData: ImageData, shortEdge?: number | null) => {
  if (!shortEdge || shortEdge <= 0) return imageData

  const currentShort = Math.min(imageData.width, imageData.height)
  if (currentShort === shortEdge) return imageData

  const scale = shortEdge / currentShort
  const targetWidth = Math.max(1, Math.round(imageData.width * scale))
  const targetHeight = Math.max(1, Math.round(imageData.height * scale))

  if (targetWidth === imageData.width && targetHeight === imageData.height) return imageData

  const sourceSurface = surfaceFromImageData(imageData)
  const targetSurface = createSurface(targetWidth, targetHeight)
  targetSurface.context.drawImage(sourceSurface.canvas as CanvasImageSource, 0, 0, targetWidth, targetHeight)
  return targetSurface.context.getImageData(0, 0, targetWidth, targetHeight)
}

const mapAvifQuality = (uiValue: number) => {
  const normalized = Math.min(100, Math.max(0, uiValue))
  const encoderValue = Math.round((normalized / 100) * 63)
  return Math.max(1, encoderValue)
}

const encodeTiff = (imageData: ImageData) => {
  const width = imageData.width
  const height = imageData.height
  const rgbData = new Uint8Array(width * height * 3)
  for (let src = 0, dst = 0; src < imageData.data.length; src += 4, dst += 3) {
    rgbData[dst] = imageData.data[src]
    rgbData[dst + 1] = imageData.data[src + 1]
    rgbData[dst + 2] = imageData.data[src + 2]
  }

  const entryCount = 10
  const headerSize = 8
  const ifdSize = 2 + entryCount * 12 + 4
  const bitsPerSampleSize = 6
  const bitsPerSampleOffset = headerSize + ifdSize
  const imageOffset = bitsPerSampleOffset + bitsPerSampleSize
  const totalSize = imageOffset + rgbData.byteLength

  const buffer = new ArrayBuffer(totalSize)
  const view = new DataView(buffer)

  view.setUint8(0, 0x49)
  view.setUint8(1, 0x49)
  view.setUint16(2, 42, true)
  view.setUint32(4, 8, true)

  const ifdStart = 8
  view.setUint16(ifdStart, entryCount, true)

  const writeEntry = (index: number, tag: number, type: number, count: number, value: number) => {
    const offset = ifdStart + 2 + index * 12
    view.setUint16(offset, tag, true)
    view.setUint16(offset + 2, type, true)
    view.setUint32(offset + 4, count, true)
    view.setUint32(offset + 8, value, true)
  }

  writeEntry(0, 256, 4, 1, width)
  writeEntry(1, 257, 4, 1, height)
  writeEntry(2, 258, 3, 3, bitsPerSampleOffset)
  writeEntry(3, 259, 3, 1, 1)
  writeEntry(4, 262, 3, 1, 2)
  writeEntry(5, 273, 4, 1, imageOffset)
  writeEntry(6, 277, 3, 1, 3)
  writeEntry(7, 278, 4, 1, height)
  writeEntry(8, 279, 4, 1, rgbData.byteLength)
  writeEntry(9, 284, 3, 1, 1)

  view.setUint32(ifdStart + 2 + entryCount * 12, 0, true)

  new Uint16Array(buffer, bitsPerSampleOffset, 3).set([8, 8, 8])
  new Uint8Array(buffer, imageOffset, rgbData.length).set(rgbData)

  return buffer
}

const encodeByFormat = async (imageData: ImageData, job: ConversionJob) => {
  if (job.targetType === 'image/avif') {
    return encodeAvif(imageData, {
      quality: mapAvifQuality(job.targetQuality),
      enableSharpYUV: true,
      chromaDeltaQ: true,
      speed: 5,
    })
  }

  if (job.targetType === 'image/webp') {
    return encodeWebp(imageData, {
      quality: job.targetQuality,
      method: 6,
      alpha_quality: 90,
      use_sharp_yuv: 1,
    })
  }

  if (job.targetType === 'image/jpeg') {
    return encodeJpeg(imageData, {
      quality: job.targetQuality,
      progressive: true,
    })
  }

  if (job.targetType === 'image/png') {
    return encodePng(imageData, { bitDepth: 8 })
  }

  return encodeTiff(imageData)
}

function App() {
  const [jobs, setJobs] = useState<ConversionJob[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const [targetFormat, setTargetFormat] = useState<TargetType>('image/avif')
  const [quality, setQuality] = useState(80)
  const [shortEdge, setShortEdge] = useState<number | null>(null)
  const [colorIntent, setColorIntent] = useState<WorkingColorProfile>('srgb')
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const codecInitRef = useRef<Promise<void> | null>(null)
  const dragDepthRef = useRef(0)

  const updateJob = useCallback((id: string, patch: Partial<ConversionJob>) => {
    setJobs((prev) => prev.map((job) => (job.id === id ? { ...job, ...patch } : job)))
  }, [])

  const ensureCodecsReady = useCallback(() => {
    if (!codecInitRef.current) {
      codecInitRef.current = (async () => {
        await Promise.all([
          initJpeg({ locateFile: JPEG_DECODE_LOCATE_FILE }),
          initPng(pngWasmUrl),
          initAvifCodec({ locateFile: AVIF_LOCATE_FILE }),
          initWebpCodec({ locateFile: WEBP_LOCATE_FILE }),
          initJpegEncoder({ locateFile: JPEG_ENCODE_LOCATE_FILE }),
          initPngEncoder(pngWasmUrl),
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

        const buffer = await job.file.arrayBuffer()
        const { imageData, profile } = await decodeSourceImage(job.sourceType, buffer)
        updateJob(job.id, { progress: 55, sourceProfile: profile })

        const resized = resizeImageData(imageData, job.shortEdge)
        const workingProfile = resolveWorkingProfile(profile)
        const converted = convertColorSpace(resized, workingProfile, job.targetColorSpace)

        updateJob(job.id, { progress: 75 })
        const encodedBuffer = await encodeByFormat(converted, job)

        const blob = new Blob([encodedBuffer], { type: job.targetType })
        const { extension } = FORMAT_LOOKUP[job.targetType]
        const downloadName = buildOutputName(job.file.name, extension)

        updateJob(job.id, { status: 'done', blob, downloadName, progress: 100 })
      } catch (error) {
        const message = error instanceof Error ? error.message : '예상하지 못한 오류가 발생했어요.'
        updateJob(job.id, { status: 'error', error: message })
      }
    },
    [ensureCodecsReady, updateJob],
  )

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      const additions: ConversionJob[] = []
      const shortEdgeTarget = shortEdge && shortEdge > 0 ? shortEdge : null

      Array.from(files).forEach((file) => {
        const sourceType: SourceType | null =
          file.type === 'image/png'
            ? 'image/png'
            : file.type === 'image/jpeg' || file.type === 'image/pjpeg'
              ? 'image/jpeg'
              : file.name.toLowerCase().endsWith('.png')
                ? 'image/png'
                : file.name.toLowerCase().match(/\.(jpg|jpeg)$/)
                  ? 'image/jpeg'
                  : null

        if (!sourceType) return

        additions.push({
          id: createJobId(),
          file,
          sourceType,
          targetType: targetFormat,
          targetColorSpace: colorIntent,
          targetQuality: quality,
          shortEdge: shortEdgeTarget,
          status: 'pending',
          progress: 0,
        })
      })

      if (additions.length === 0) return
      setJobs((prev) => [...prev, ...additions])
    },
    [colorIntent, quality, shortEdge, targetFormat],
  )

  const pendingJobs = useMemo(() => jobs.filter((job) => job.status === 'pending'), [jobs])
  const handleDrop = (event: DragEvent<HTMLDivElement | HTMLBodyElement>) => {
    event.preventDefault()
    dragDepthRef.current = 0
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

  const formatSupportsQuality = FORMAT_LOOKUP[targetFormat].supportsQuality
  const handleStartConversion = () => {
    pendingJobs.forEach((job) => {
      runConversion(job)
    })
  }

  return (
    <div
      className={`app-shell ${isDragging ? 'is-dragging' : ''}`}
      onDragEnter={(event) => {
        event.preventDefault()
        dragDepthRef.current += 1
        setIsDragging(true)
      }}
      onDragOver={(event) => {
        event.preventDefault()
      }}
      onDragLeave={(event) => {
        event.preventDefault()
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
        if (dragDepthRef.current === 0) {
          setIsDragging(false)
        }
      }}
      onDrop={handleDrop}
    >
      <div className={`drag-overlay ${isDragging ? 'visible' : ''}`}>Drop images to queue</div>

      <header className="site-header">
        <div className="logo">
          <a href="#">
            <span className="original-name">Studio Convert</span>
            <span className="hover-name">Jiwon Choi Atelier</span>
          </a>
        </div>
        <nav className="main-nav">
          <ul>
            <li>Queue {jobs.length}</li>
            <li>Done {finishedJobs.length}</li>
            <li>{FORMAT_LOOKUP[targetFormat].label.toUpperCase()}</li>
          </ul>
        </nav>
      </header>

      <main className="workspace">
        <section className="panel control-panel">
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
          <button type="button" onClick={handleBrowse}>
            Select files
          </button>
          <button type="button" onClick={() => setJobs([])} disabled={!jobs.length}>
            Reset queue
          </button>
          <hr />
          <label>
            Format
            <select value={targetFormat} onChange={(event) => setTargetFormat(event.target.value as TargetType)}>
              {FORMAT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Short edge (px)
            <input
              type="number"
              min={0}
              placeholder="원본"
              value={shortEdge ?? ''}
              onChange={(event) => {
                if (event.target.value === '') {
                  setShortEdge(null)
                  return
                }
                const next = Number(event.target.value)
                setShortEdge(Number.isNaN(next) || next <= 0 ? null : Math.round(next))
              }}
            />
          </label>
          <label>
            Color space
            <select value={colorIntent} onChange={(event) => setColorIntent(event.target.value as WorkingColorProfile)}>
              {COLOR_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className={`quality-control ${formatSupportsQuality ? '' : 'is-disabled'}`}>
            Quality
            <input
              type="range"
              min={0}
              max={100}
              step={10}
              value={quality}
              onChange={(event) => setQuality(Number(event.target.value))}
              disabled={!formatSupportsQuality}
            />
            <span>{formatSupportsQuality ? quality : '고정'}</span>
          </label>
          <button type="button" className="primary" onClick={handleStartConversion} disabled={!pendingJobs.length}>
            Start conversion
          </button>
        </section>

        <section className="panel result-panel">
          <div className="result-header">
            <div>
              <span>Pending {pendingJobs.length}</span>
              <span>Active {activeJobs.length}</span>
              <span>Done {finishedJobs.length}</span>
            </div>
            <div className="control-buttons">
              <button type="button" onClick={handleDownloadArchive} disabled={!finishedJobs.length}>
                Download ZIP
              </button>
            </div>
          </div>

          <div className="job-list">
            {jobs.length === 0 && <p className="empty">Drag images anywhere to begin.</p>}
            {jobs.map((job) => {
              const sourceLabel = SOURCE_LABELS[job.sourceType]
              const { label: targetLabel, supportsQuality } = FORMAT_LOOKUP[job.targetType]
              const profileLabel = job.sourceProfile
                ? `${job.sourceProfile === 'unknown' ? 'sRGB' : job.sourceProfile.toUpperCase()} → ${job.targetColorSpace.toUpperCase()}`
                : `→ ${job.targetColorSpace.toUpperCase()}`
              const shortEdgeLabel = job.shortEdge ? `${job.shortEdge}px` : '원본'
              const qualityLabel = supportsQuality ? `${job.targetQuality}` : '고정'

              return (
                <article key={job.id} className={`job-card status-${job.status}`}>
                  <div className="job-meta">
                    <div>
                      <p className="job-name">{job.file.name}</p>
                      <p className="job-hint">
                        {sourceLabel} → {targetLabel} · {profileLabel}
                      </p>
                    </div>
                    <div className="job-status">
                      {job.status === 'processing' && <span>Processing</span>}
                      {job.status === 'pending' && <span>Waiting</span>}
                      {job.status === 'done' && <span>Done</span>}
                      {job.status === 'error' && <span>Error</span>}
                    </div>
                  </div>

                  <div className="job-specs">
                    <span>Short {shortEdgeLabel}</span>
                    <span>Color {job.targetColorSpace.toUpperCase()}</span>
                    <span>Quality {qualityLabel}</span>
                  </div>

                  <div className="progress">
                    <div className="progress-bar" style={{ width: `${job.progress}%` }} />
                  </div>

                  {job.status === 'error' && <p className="job-error">{job.error}</p>}

                  {job.status === 'done' && job.blob && job.downloadName && (
                    <div className="job-actions">
                      <button type="button" onClick={() => handleDownloadSingle(job)}>
                        Download
                      </button>
                    </div>
                  )}
                </article>
              )
            })}
          </div>
        </section>
      </main>
    </div>
  )
}

export default App
