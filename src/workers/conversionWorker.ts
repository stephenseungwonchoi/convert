/// <reference lib="webworker" />
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
import type { ColorProfile, SourceType, WorkerConvertRequest, WorkerResponse, WorkingColorProfile } from '../lib/types'

const ctx = self as DedicatedWorkerGlobalScope

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

const codecInitPromise = (async () => {
  await Promise.all([
    initJpeg({ locateFile: JPEG_DECODE_LOCATE_FILE }),
    initPng(pngWasmUrl),
    initAvifCodec({ locateFile: AVIF_LOCATE_FILE }),
    initWebpCodec({ locateFile: WEBP_LOCATE_FILE }),
    initJpegEncoder({ locateFile: JPEG_ENCODE_LOCATE_FILE }),
    initPngEncoder(pngWasmUrl),
  ])
})()

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

type Matrix3 = [number, number, number][]

const SRGB_TO_XYZ: Matrix3 = [
  [0.4124564, 0.3575761, 0.1804375],
  [0.2126729, 0.7151522, 0.072175],
  [0.0193339, 0.119192, 0.9503041],
]

const XYZ_TO_SRGB: Matrix3 = [
  [3.2406, -1.5372, -0.4986],
  [-0.9689, 1.8758, 0.0415],
  [0.0557, -0.204, 1.057],
]

const ADOBE_TO_XYZ: Matrix3 = [
  [0.5767309, 0.185554, 0.1881852],
  [0.2973769, 0.6273491, 0.0752741],
  [0.0270343, 0.0706872, 0.9911085],
]

const XYZ_TO_ADOBE: Matrix3 = [
  [2.041369, -0.5649464, -0.3446944],
  [-0.969266, 1.8760108, 0.041556],
  [0.0134474, -0.1183897, 1.0154096],
]

type ColorProfileConfig = {
  toLinear: (value: number) => number
  fromLinear: (value: number) => number
  rgbToXyz: Matrix3
  xyzToRgb: Matrix3
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

const multiplyMatrix = (matrix: Matrix3, vector: [number, number, number]) => {
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

const createSurface = (width: number, height: number) => {
  if (typeof OffscreenCanvas === 'undefined') {
    throw new Error('OffscreenCanvas is not supported in this environment.')
  }
  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' })
  if (!context) {
    throw new Error('Unable to acquire drawing context.')
  }
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

const encodeByFormat = async (imageData: ImageData, request: WorkerConvertRequest) => {
  if (request.targetType === 'image/avif') {
    return encodeAvif(imageData, {
      quality: mapAvifQuality(request.targetQuality),
      enableSharpYUV: true,
      chromaDeltaQ: true,
      speed: 5,
    })
  }

  if (request.targetType === 'image/webp') {
    return encodeWebp(imageData, {
      quality: request.targetQuality,
      method: 6,
      alpha_quality: 90,
      use_sharp_yuv: 1,
    })
  }

  if (request.targetType === 'image/jpeg') {
    return encodeJpeg(imageData, {
      quality: request.targetQuality,
      progressive: true,
    })
  }

  if (request.targetType === 'image/png') {
    return encodePng(imageData, { bitDepth: 8 })
  }

  return encodeTiff(imageData)
}

ctx.onmessage = async (event: MessageEvent<WorkerConvertRequest>) => {
  const message = event.data
  try {
    await codecInitPromise
    ctx.postMessage({ type: 'progress', id: message.id, progress: 20 } satisfies WorkerResponse)

    const { imageData, profile } = await decodeSourceImage(message.sourceType, message.buffer)
    ctx.postMessage({ type: 'progress', id: message.id, progress: 45 } satisfies WorkerResponse)

    const resized = resizeImageData(imageData, message.shortEdge)
    const workingProfile = resolveWorkingProfile(profile)
    const converted = convertColorSpace(resized, workingProfile, message.targetColorSpace)

    ctx.postMessage({ type: 'progress', id: message.id, progress: 70 } satisfies WorkerResponse)
    const encodedBuffer = await encodeByFormat(converted, message)

    ctx.postMessage(
      {
        type: 'done',
        id: message.id,
        buffer: encodedBuffer,
        mime: message.targetType,
        sourceProfile: profile,
      } satisfies WorkerResponse,
      [encodedBuffer],
    )
  } catch (error) {
    const err = error instanceof Error ? error.message : 'Unexpected error'
    ctx.postMessage({ type: 'error', id: message.id, error: err } satisfies WorkerResponse)
  }
}
