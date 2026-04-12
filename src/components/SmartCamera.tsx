import { useEffect, useRef, useState } from 'react'
import './SmartCamera.css'

// @ts-expect-error - cv is loaded from opencv.js script
const getCV = () => window.cv

/* ─────────────────────────────────────────────────────────────
   Types & Constants
───────────────────────────────────────────────────────────── */
interface Photo { 
  id: string; 
  dataUrl: string; 
  timestamp: number;
}

type Point = { x: number, y: number }

const AW = 320, AH = 240
const MIN_AREA_PERCENT = 5
const MAX_AREA_PERCENT = 95

/* ─────────────────────────────────────────────────────────────
   Component
───────────────────────────────────────────────────────────── */
export default function SmartCamera() {
  const videoRef      = useRef<HTMLVideoElement>(null)
  const overlayRef    = useRef<HTMLCanvasElement>(null)
  const contourRef    = useRef<any>(null)

  const [photos,      setPhotos]      = useState<Photo[]>([])
  const [selected,    setSelected]    = useState<Photo | null>(null)
  const [label,       setLabel]       = useState('OpenCV yuklanmoqda...')
  const [isCvReady,   setIsCvReady]   = useState(false)
  const [isSnapping,  setIsSnapping]  = useState(false)
  const [detected,    setDetected]    = useState(false)

  // ── OpenCV tayyor bo'lishini kutish ──────────────────────
  useEffect(() => {
    const cvPoll = setInterval(() => {
      // @ts-expect-error
      if (window.cv?.getBuildInformation) {
        clearInterval(cvPoll)
        setLabel('📷 Kamerani sozlash...')
        setIsCvReady(true)
      }
    }, 100)
    return () => clearInterval(cvPoll)
  }, [])

  // ── Nuqtalarni to'g'ri tartiblash (TL, TR, BR, BL) ──────────
  function orderCorners(points: Point[]): Point[] {
    const center = {
      x: points.reduce((sum, p) => sum + p.x, 0) / 4,
      y: points.reduce((sum, p) => sum + p.y, 0) / 4
    }
    
    return [...points].sort((a, b) => {
      const angleA = Math.atan2(a.y - center.y, a.x - center.x)
      const angleB = Math.atan2(b.y - center.y, b.x - center.x)
      return angleA - angleB
    })
  }

  // ── Rasm sifatini yaxshilash ──────────────────────────────
  function enhanceImage(canvas: HTMLCanvasElement): HTMLCanvasElement {
    const result = document.createElement('canvas')
    result.width = canvas.width
    result.height = canvas.height
    const ctx = result.getContext('2d')!
    
    ctx.drawImage(canvas, 0, 0)
    
    const imageData = ctx.getImageData(0, 0, result.width, result.height)
    const data = imageData.data
    
    const contrast = 1.2
    const brightness = 10
    
    for (let i = 0; i < data.length; i += 4) {
      data[i] = Math.min(255, Math.max(0, (data[i] - 128) * contrast + 128 + brightness))
      data[i+1] = Math.min(255, Math.max(0, (data[i+1] - 128) * contrast + 128 + brightness))
      data[i+2] = Math.min(255, Math.max(0, (data[i+2] - 128) * contrast + 128 + brightness))
    }
    
    ctx.putImageData(imageData, 0, 0)
    return result
  }

  // ── Rasmga olish va perspektivani to'g'irlash ──────────────
  async function captureAndCorrect(): Promise<string | null> {
    const cv = getCV()
    const video = videoRef.current
    if (!video || video.readyState < 2 || !contourRef.current) return null
    
    setIsSnapping(true)
    
    try {
      const fullCanvas = document.createElement('canvas')
      fullCanvas.width = video.videoWidth
      fullCanvas.height = video.videoHeight
      const ctx = fullCanvas.getContext('2d')!
      ctx.drawImage(video, 0, 0, fullCanvas.width, fullCanvas.height)
      
      const srcMat = cv.imread(fullCanvas)
      
      const rawCorners: Point[] = []
      for (let i = 0; i < contourRef.current.rows; i++) {
        rawCorners.push({
          x: contourRef.current.data32S[i * 2],
          y: contourRef.current.data32S[i * 2 + 1]
        })
      }
      
      const ratioX = video.videoWidth / AW
      const ratioY = video.videoHeight / AH
      
      const corners: Point[] = rawCorners.map(c => ({
        x: c.x * ratioX,
        y: c.y * ratioY
      }))
      
      const ordered = orderCorners(corners)
      
      const tl = ordered[0]
      const tr = ordered[1]
      const br = ordered[2]
      const bl = ordered[3]
      
      const widthTop = Math.hypot(tr.x - tl.x, tr.y - tl.y)
      const widthBottom = Math.hypot(br.x - bl.x, br.y - bl.y)
      const width = Math.max(widthTop, widthBottom)
      
      const heightLeft = Math.hypot(bl.x - tl.x, bl.y - tl.y)
      const heightRight = Math.hypot(br.x - tr.x, br.y - tr.y)
      const height = Math.max(heightLeft, heightRight)
      
      const srcPoints = cv.matFromArray(4, 1, cv.CV_32FC2, [
        tl.x, tl.y,
        tr.x, tr.y,
        br.x, br.y,
        bl.x, bl.y
      ])
      
      const dstPoints = cv.matFromArray(4, 1, cv.CV_32FC2, [
        0, 0,
        width, 0,
        width, height,
        0, height
      ])
      
      const perspectiveMat = cv.getPerspectiveTransform(srcPoints, dstPoints)
      
      const warpedMat = new cv.Mat()
      cv.warpPerspective(srcMat, warpedMat, perspectiveMat, new cv.Size(width, height))
      
      const warpedCanvas = document.createElement('canvas')
      cv.imshow(warpedCanvas, warpedMat)
      
      srcMat.delete()
      warpedMat.delete()
      perspectiveMat.delete()
      srcPoints.delete()
      dstPoints.delete()
      
      const finalCanvas = enhanceImage(warpedCanvas)
      
      return finalCanvas.toDataURL('image/jpeg', 0.95)
      
    } catch (error) {
      console.error('Capture error:', error)
      return null
    } finally {
      setIsSnapping(false)
    }
  }

  // ── Konturni chizish ─────────────────────────────────────
  function drawBorder(contour: any, isStable: boolean) {
    const overlay = overlayRef.current
    if (!overlay) return
    
    const ctx = overlay.getContext('2d')
    if (!ctx) return

    const W = overlay.width
    const H = overlay.height
    
    ctx.clearRect(0, 0, W, H)
    if (!contour) return

    const sx = W / AW
    const sy = H / AH
    
    const color = isStable ? '#22c55e' : '#3b82f6'
    const shadowBlur = isStable ? 20 : 10
    
    ctx.strokeStyle = color
    ctx.lineWidth = 4
    ctx.shadowColor = color
    ctx.shadowBlur = shadowBlur
    ctx.fillStyle = isStable ? 'rgba(34,197,94,0.1)' : 'rgba(59,130,246,0.05)'
    
    const points: Point[] = []
    for (let i = 0; i < contour.rows; i++) {
      points.push({
        x: contour.data32S[i * 2] * sx,
        y: contour.data32S[i * 2 + 1] * sy
      })
    }
    
    ctx.beginPath()
    ctx.moveTo(points[0].x, points[0].y)
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y)
    }
    ctx.closePath()
    ctx.fill()
    ctx.stroke()
    
    if (isStable && points.length === 4) {
      ctx.fillStyle = '#22c55e'
      points.forEach(p => {
        ctx.beginPath()
        ctx.arc(p.x, p.y, 6, 0, 2 * Math.PI)
        ctx.fill()
        ctx.shadowBlur = 0
        ctx.fillStyle = 'white'
        ctx.beginPath()
        ctx.arc(p.x, p.y, 3, 0, 2 * Math.PI)
        ctx.fill()
        ctx.fillStyle = '#22c55e'
      })
    }
  }

  // ── Asosiy tahlil sikli ───────────────────────────────────
  useEffect(() => {
    if (!isCvReady) return

    const video = videoRef.current
    const overlay = overlayRef.current
    if (!video || !overlay) return

    const analysisCanvas = document.createElement('canvas')
    analysisCanvas.width = AW
    analysisCanvas.height = AH
    const analysisCtx = analysisCanvas.getContext('2d', { willReadFrequently: true })
    if (!analysisCtx) return

    let stream: MediaStream
    let intervalId: ReturnType<typeof setInterval>

    function analyze() {
      const cv = getCV()
      const videoElement = videoRef.current
      const overlayElement = overlayRef.current
      
      if (!videoElement || !overlayElement) return
      if (videoElement.readyState < 2) return

      const rect = videoElement.getBoundingClientRect()
      if (overlayElement.width !== Math.round(rect.width)) overlayElement.width = Math.round(rect.width)
      if (overlayElement.height !== Math.round(rect.height)) overlayElement.height = Math.round(rect.height)

      analysisCtx!.drawImage(videoElement, 0, 0, AW, AH);
      
      const src = cv.imread(analysisCanvas)
      const gray = new cv.Mat()
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY)
      
      const blurred = new cv.Mat()
      cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0)
      
      const thresh = new cv.Mat()
      cv.adaptiveThreshold(blurred, thresh, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 21, 4)
      
      const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3))
      const morphed = new cv.Mat()
      cv.morphologyEx(thresh, morphed, cv.MORPH_CLOSE, kernel)
      
      const contours = new cv.MatVector()
      const hierarchy = new cv.Mat()
      cv.findContours(morphed, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE)
      
      let maxArea = 0
      let bestContour = null
      const frameArea = AW * AH
      
      for (let i = 0; i < contours.size(); i++) {
        const c = contours.get(i)
        const area = cv.contourArea(c)
        const areaPercent = (area / frameArea) * 100
        
        if (areaPercent >= MIN_AREA_PERCENT && areaPercent <= MAX_AREA_PERCENT && area > maxArea) {
          const peri = cv.arcLength(c, true)
          const approx = new cv.Mat()
          cv.approxPolyDP(c, approx, 0.01 * peri, true)
          
          if (approx.rows >= 3 && approx.rows <= 8) {
            maxArea = area
            if (bestContour) bestContour.delete()
            bestContour = approx.clone()
          }
          approx.delete()
        }
        c.delete()
      }
      
      if (bestContour && bestContour.rows !== 4) {
        const rectBox = cv.boundingRect(bestContour)
        const rectContour = cv.matFromArray(4, 1, cv.CV_32SC2, [
          rectBox.x, rectBox.y,
          rectBox.x + rectBox.width, rectBox.y,
          rectBox.x + rectBox.width, rectBox.y + rectBox.height,
          rectBox.x, rectBox.y + rectBox.height
        ])
        bestContour.delete()
        bestContour = rectContour
      }
      
      if (contourRef.current) contourRef.current.delete()
      contourRef.current = bestContour
      
      const isDetected = bestContour !== null

      if (isDetected) {
        drawBorder(bestContour, true)
        setDetected(true)
        setLabel('📄 Hujjat aniqlandi')
      } else {
        drawBorder(null, false)
        setDetected(false)
        setLabel('🔍 Hujjatni ko\'rsating')
      }
      
      src.delete()
      gray.delete()
      blurred.delete()
      thresh.delete()
      kernel.delete()
      morphed.delete()
      contours.delete()
      hierarchy.delete()
    }

    navigator.mediaDevices
      .getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 }
        }
      })
      .then(s => {
        stream = s
        if (!video) return
        video.srcObject = s

        const startAnalysis = () => {
          video.play().then(() => {
            intervalId = setInterval(analyze, 150)
          }).catch(err => {
            console.error('Play error:', err)
            setLabel('❌ Video xatosi: ' + err.message)
          })
        }

        if (video.readyState >= 2) {
          startAnalysis()
        } else {
          video.addEventListener('loadedmetadata', startAnalysis, { once: true })
        }
      })
      .catch(err => {
        console.error('Camera error:', err)
        setLabel('❌ Kamera xatosi: ' + err.message)
      })

    return () => {
      clearInterval(intervalId)
      if (stream) stream.getTracks().forEach(track => track.stop())
      if (contourRef.current) contourRef.current.delete()
    }
  }, [isCvReady])

  // ── Rasmni o'chirish ───────────────────────────────────
  function deletePhoto(id: string) {
    setPhotos(prev => prev.filter(p => p.id !== id))
    if (selected?.id === id) setSelected(null)
  }

  // ── Barcha rasmlarni zip qilish ─────────────────────────
  async function downloadAll() {
    if (!photos.length) return
    
    const { default: JSZip } = await import('jszip')
    const zip = new JSZip()
    
    photos.forEach((photo, i) => {
      zip.file(`document_${String(i + 1).padStart(3, '0')}.jpg`, photo.dataUrl.split(',')[1], { base64: true })
    })
    
    const blob = await zip.generateAsync({ type: 'blob' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `scan_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.zip`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  // ── Render ──────────────────────────────────────────────
  return (
    <div className='smartCamera'>
      <div className='cameraSection'>
        <div className='cameraContainer'>
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className='video'
          />
          <canvas ref={overlayRef} className='overlay' />
          
          <div className={`statusPill ${isSnapping ? 'snapping' : ''}`}>
            <span className={`statusDot ${detected ? 'green' : 'gray'}`} />
            {label}
          </div>

          <button
            className={`captureBtn ${detected ? 'active' : ''}`}
            disabled={!detected || isSnapping}
            onClick={() => {
              captureAndCorrect().then(dataUrl => {
                if (dataUrl) {
                  setPhotos(prev => [...prev, {
                    id: Date.now().toString(),
                    dataUrl,
                    timestamp: Date.now()
                  }])
                }
              })
            }}
          >
            📸
          </button>
        </div>
      </div>

      <div className='gallerySection'>
        <div className='galleryHeader'>
          <span className='galleryTitle'>
            📸 Skanerlangan hujjatlar ({photos.length})
          </span>
          {photos.length > 0 && (
            <button onClick={downloadAll} className='downloadBtn'>
              📥 ZIP
            </button>
          )}
        </div>
        
        <div className='thumbnailList'>
          {photos.length === 0 ? (
            <div className='emptyState'>
              <span>📄</span>
              <p>Hujjatni ramkaga joylashtiring</p>
              <small>Avtomatik skanerlanadi</small>
            </div>
          ) : (
            photos.map((photo, i) => (
              <button
                key={photo.id}
                onClick={() => setSelected(photo)}
                className='thumbnail'
              >
                <img src={photo.dataUrl} alt={`Skaner ${i + 1}`} />
                <span className='thumbnailNumber'>{i + 1}</span>
              </button>
            ))
          )}
        </div>
      </div>

      {selected && (
        <div className='modal' onClick={() => setSelected(null)}>
          <div className='modalContent' onClick={e => e.stopPropagation()}>
            <div className='modalHeader'>
              <button onClick={() => setSelected(null)} className='backBtn'>
                ← Orqaga
              </button>
              <span className='modalCounter'>
                #{photos.findIndex(p => p.id === selected.id) + 1} / {photos.length}
              </span>
              <button onClick={() => deletePhoto(selected.id)} className='deleteBtn'>
                🗑️ O'chirish
              </button>
            </div>
            <img src={selected.dataUrl} alt="Preview" className='modalImage' />
          </div>
        </div>
      )}
    </div>
  )
}