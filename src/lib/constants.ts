import type { SourceType, TargetType, WorkingColorProfile } from './types'

export const FORMAT_OPTIONS: Array<{ value: TargetType; label: string; extension: string; supportsQuality: boolean }> = [
  { value: 'image/avif', label: 'AVIF', extension: 'avif', supportsQuality: true },
  { value: 'image/webp', label: 'WebP', extension: 'webp', supportsQuality: true },
  { value: 'image/jpeg', label: 'JPEG', extension: 'jpg', supportsQuality: true },
  { value: 'image/png', label: 'PNG', extension: 'png', supportsQuality: false },
  { value: 'image/tiff', label: 'TIFF', extension: 'tiff', supportsQuality: false },
]

export const FORMAT_LOOKUP: Record<TargetType, { label: string; extension: string; supportsQuality: boolean }> = FORMAT_OPTIONS.reduce(
  (acc, option) => ({ ...acc, [option.value]: { label: option.label, extension: option.extension, supportsQuality: option.supportsQuality } }),
  {} as Record<TargetType, { label: string; extension: string; supportsQuality: boolean }>,
)

export const COLOR_OPTIONS: Array<{ value: WorkingColorProfile; label: string }> = [
  { value: 'srgb', label: 'sRGB' },
  { value: 'adobe-rgb', label: 'Adobe RGB' },
]

export const SOURCE_LABELS: Record<SourceType, string> = {
  'image/jpeg': 'JPEG',
  'image/png': 'PNG',
}
