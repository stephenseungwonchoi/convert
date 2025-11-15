import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import JSZip from 'jszip'
import './App.css'
import { COLOR_OPTIONS, FORMAT_LOOKUP, FORMAT_OPTIONS, SOURCE_LABELS } from './lib/constants'
import type {
  ColorProfile,
  ConversionStatus,
  SourceType,
  TargetType,
  WorkerConvertRequest,
  WorkerResponse,
  WorkingColorProfile,
} from './lib/types'

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

const workerFactory = () => new Worker(new URL('./workers/conversionWorker.ts', import.meta.url), { type: 'module' })

type WorkerWrapper = {
  worker: Worker
  busy: boolean
  currentTaskId?: string
}

class ConversionWorkerPool {
  private workers: WorkerWrapper[]
  private queue: WorkerConvertRequest[] = []
  private onMessage: (message: WorkerResponse) => void

  constructor(size: number, onMessage: (message: WorkerResponse) => void) {
    this.onMessage = onMessage
    this.workers = Array.from({ length: size }, () => this.createWorker())
  }

  private createWorker(): WorkerWrapper {
    const worker = workerFactory()
    const wrapper: WorkerWrapper = { worker, busy: false }
    worker.onmessage = (event) => {
      const message = event.data as WorkerResponse
      this.handleMessage(wrapper, message)
    }
    worker.onerror = (event) => {
      console.error('Worker error', event)
      const currentId = wrapper.currentTaskId
      if (currentId) {
        this.onMessage({ type: 'error', id: currentId, error: event.message } satisfies WorkerResponse)
      }
      wrapper.busy = false
      wrapper.currentTaskId = undefined
      this.dispatch()
    }
    return wrapper
  }

  private handleMessage(wrapper: WorkerWrapper, message: WorkerResponse) {
    if (message.type === 'done' || message.type === 'error') {
      wrapper.busy = false
      wrapper.currentTaskId = undefined
      this.dispatch()
    }
    this.onMessage(message)
  }

  enqueue(command: WorkerConvertRequest) {
    this.queue.push(command)
    this.dispatch()
  }

  private dispatch() {
    const wrapper = this.workers.find((worker) => !worker.busy)
    if (!wrapper) return
    const command = this.queue.shift()
    if (!command) return
    wrapper.busy = true
    wrapper.currentTaskId = command.id
    wrapper.worker.postMessage(command, [command.buffer])
  }

  terminate() {
    this.workers.forEach((wrapper) => wrapper.worker.terminate())
  }
}

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


function App() {
  const [jobs, setJobs] = useState<ConversionJob[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const [targetFormat, setTargetFormat] = useState<TargetType>('image/avif')
  const [quality, setQuality] = useState(80)
  const [shortEdge, setShortEdge] = useState<number | null>(null)
  const [colorIntent, setColorIntent] = useState<WorkingColorProfile>('srgb')
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const dragDepthRef = useRef(0)
  const workerPoolRef = useRef<ConversionWorkerPool | null>(null)

  const updateJob = useCallback(
    (id: string, patch: Partial<ConversionJob> | ((job: ConversionJob) => Partial<ConversionJob>)) => {
      setJobs((prev) =>
        prev.map((job) => {
          if (job.id !== id) return job
          const nextPatch = typeof patch === 'function' ? patch(job) : patch
          return { ...job, ...nextPatch }
        }),
      )
    },
    [],
  )

  const handleWorkerMessage = useCallback(
    (message: WorkerResponse) => {
      if (message.type === 'progress') {
        updateJob(message.id, { progress: Math.min(99, message.progress) })
        return
      }

      if (message.type === 'done') {
        const blob = new Blob([message.buffer], { type: message.mime })
        updateJob(message.id, (job) => {
          const { extension } = FORMAT_LOOKUP[job.targetType]
          const downloadName = buildOutputName(job.file.name, extension)
          return {
            status: 'done',
            progress: 100,
            blob,
            downloadName,
            sourceProfile: message.sourceProfile,
          }
        })
        return
      }

      updateJob(message.id, { status: 'error', error: message.error })
    },
    [updateJob],
  )

  useEffect(() => {
    const pool = new ConversionWorkerPool(8, handleWorkerMessage)
    workerPoolRef.current = pool
    return () => {
      pool.terminate()
      workerPoolRef.current = null
    }
  }, [handleWorkerMessage])

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
  useEffect(() => {
    setJobs((prev) => {
      let mutated = false
      const next = prev.map((job) => {
        if (job.status !== 'pending' || job.targetQuality === quality) {
          return job
        }
        mutated = true
        return { ...job, targetQuality: quality }
      })
      return mutated ? next : prev
    })
  }, [quality])
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
  const activeJobs = useMemo(() => jobs.filter((job) => job.status === 'processing'), [jobs])

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
    if (formatSupportsQuality && quality === 0) {
      window.alert('Increase quality above 0 to start conversion.')
      return
    }

    const pool = workerPoolRef.current
    if (!pool) return
    pendingJobs.forEach((job) => {
      updateJob(job.id, { status: 'processing', progress: 5, error: undefined })
      job.file
        .arrayBuffer()
        .then((buffer) => {
          pool.enqueue({
            id: job.id,
            fileName: job.file.name,
            sourceType: job.sourceType,
            targetType: job.targetType,
            targetColorSpace: job.targetColorSpace,
            targetQuality: job.targetQuality,
            shortEdge: job.shortEdge,
            buffer,
          })
        })
        .catch((error) => {
          updateJob(job.id, {
            status: 'error',
            error: error instanceof Error ? error.message : 'Failed to read file.',
          })
        })
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
        <div className="logo">Seungwon Choi Convert</div>
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
              placeholder="Original"
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
              step={1}
              value={quality}
              onChange={(event) => setQuality(Number(event.target.value))}
              disabled={!formatSupportsQuality}
            />
            <span>{formatSupportsQuality ? quality : 'Fixed'}</span>
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
              const shortEdgeLabel = job.shortEdge ? `${job.shortEdge}px` : 'Original'
              const qualityLabel = supportsQuality ? `${job.targetQuality}` : 'Fixed'

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
                      {job.status === 'error' && <span>Error</span>}
                      {job.status === 'done' && (
                        <span>
                          Done
                          {job.blob && job.downloadName && (
                            <>
                              {' '}
                              ·{' '}
                              <button type="button" className="inline-download" onClick={() => handleDownloadSingle(job)}>
                                download
                              </button>
                            </>
                          )}
                        </span>
                      )}
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
