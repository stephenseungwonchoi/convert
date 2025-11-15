export type SourceType = 'image/jpeg' | 'image/png'
export type TargetType = 'image/avif' | 'image/webp' | 'image/jpeg' | 'image/png' | 'image/tiff'
export type ConversionStatus = 'pending' | 'processing' | 'done' | 'error'
export type ColorProfile = 'srgb' | 'adobe-rgb' | 'unknown'
export type WorkingColorProfile = Exclude<ColorProfile, 'unknown'>

export type WorkerConvertRequest = {
  id: string
  fileName: string
  sourceType: SourceType
  targetType: TargetType
  targetColorSpace: WorkingColorProfile
  targetQuality: number
  shortEdge?: number | null
  buffer: ArrayBuffer
}

export type WorkerProgressMessage = {
  type: 'progress'
  id: string
  progress: number
}

export type WorkerDoneMessage = {
  type: 'done'
  id: string
  buffer: ArrayBuffer
  mime: TargetType
  sourceProfile: ColorProfile
}

export type WorkerErrorMessage = {
  type: 'error'
  id: string
  error: string
}

export type WorkerResponse = WorkerProgressMessage | WorkerDoneMessage | WorkerErrorMessage
