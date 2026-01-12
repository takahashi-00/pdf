import React, { useState, useEffect, useRef, useCallback } from 'react';
import { 
  FilePlus, 
  Trash2, 
  Square, 
  ArrowUpRight, 
  Type, 
  Grid, 
  Download, 
  Loader2,
  Layers,
  MousePointer2,
  RotateCw,
  Image as ImageIcon,
  File,
  GripVertical,
  ZoomIn,
  ZoomOut,
  Maximize,
  Pipette,
  RectangleHorizontal,
  Eraser,
  Sliders,
  ArrowUp,
  ArrowDown,
  BringToFront,
  SendToBack,
  ChevronUp,
  ChevronDown
} from 'lucide-react';

const useExternalScripts = (urls) => {
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let mounted = true;
    const loadScripts = async () => {
      for (const url of urls) {
        if (!document.querySelector(`script[src="${url}"]`)) {
          await new Promise((resolve) => {
            const script = document.createElement('script');
            script.src = url;
            script.async = true;
            script.onload = resolve;
            document.head.appendChild(script);
          });
        }
      }
      if (mounted) setLoaded(true);
    };
    loadScripts();
    return () => { mounted = false; };
  }, [urls]);
  return loaded;
};

const PDF_LIB_URL = 'https://unpkg.com/pdf-lib/dist/pdf-lib.min.js';
const PDFJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
const FABRIC_URL = 'https://cdnjs.cloudflare.com/ajax/libs/fabric.js/5.3.1/fabric.min.js';

export default function App() {
  const scriptsLoaded = useExternalScripts([PDFJS_URL, FABRIC_URL, PDF_LIB_URL]);
  
  const [pages, setPages] = useState([]);
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [isLoading, setIsLoading] = useState(false);
  const [tool, setTool] = useState('select');
  const [zoomLevel, setZoomLevel] = useState(1);
  const [properties, setProperties] = useState({
    color: '#ef4444', 
    opacity: 1,
    size: 5,
  });

  const [draggedIndex, setDraggedIndex] = useState(null);
  const [dropTargetIndex, setDropTargetIndex] = useState(null);
  
  const canvasRef = useRef(null);
  const fabricCanvas = useRef(null);
  const fileInputRef = useRef(null);
  const imageInputRef = useRef(null);
  const workspaceRef = useRef(null);
  const isUpdatingRef = useRef(false);

  const presetColors = ['#ef4444', '#3b82f6', '#22c55e', '#000000', '#ffffff', '#eab308', '#64748b'];

  // --------------------------------------------------------------------------
  // Canvas State Management
  // --------------------------------------------------------------------------

  const saveCurrentState = useCallback(() => {
    if (!fabricCanvas.current || currentIndex === -1 || isUpdatingRef.current) return;
    const currentPageId = pages[currentIndex]?.id;
    if (!currentPageId) return;

    // 保存対象のプロパティを指定
    const json = fabricCanvas.current.toJSON([
        'id', 'isMosaic', 'mosaicSize', 'selectable', 'evented', 'strokeUniform', 'lockUniScaling'
    ]);
    
    setPages(prev => {
      if (!prev[currentIndex] || prev[currentIndex].id !== currentPageId) return prev;
      if (JSON.stringify(prev[currentIndex].fabricData) === JSON.stringify(json)) return prev;
      
      const newPages = [...prev];
      newPages[currentIndex] = { ...newPages[currentIndex], fabricData: json };
      return newPages;
    });
  }, [currentIndex, pages]);

  const syncProperties = useCallback((obj) => {
    if (!obj) return;
    let currentSize = 5;
    if (obj.isMosaic) {
        currentSize = obj.mosaicSize || 10;
    } else if (obj.type === 'i-text') {
        currentSize = Math.round((obj.fontSize || 40) / 4);
    } else if (obj.strokeWidth) {
        currentSize = obj.strokeWidth;
    }
    setProperties(prev => ({
      ...prev,
      color: obj.fill === 'transparent' ? obj.stroke : (typeof obj.fill === 'string' ? obj.fill : prev.color),
      opacity: obj.opacity || 1,
      size: currentSize
    }));
  }, []);

  // --------------------------------------------------------------------------
  // Mosaic Logic (Captured Image Method)
  // --------------------------------------------------------------------------

  // モザイク更新処理：指定オブジェクトの領域をキャプチャし、モザイク加工した画像をセットする
  const updateMosaicContent = useCallback((obj) => {
    if (!fabricCanvas.current || !obj || !obj.isMosaic) return;
    const canvas = fabricCanvas.current;
    
    // 自分自身を一時的に非表示にして、背景（または下のレイヤー）だけが見える状態にする
    const originalVisible = obj.visible;
    obj.visible = false;
    
    // 背景描画更新（これがないと非表示が反映されない場合がある）
    canvas.renderAll();

    // オブジェクトの領域を取得（絶対座標）
    const rect = obj.getBoundingRect(true); 
    
    // 範囲が無効なら処理しない
    if (rect.width <= 0 || rect.height <= 0) {
        obj.visible = originalVisible;
        return;
    }

    // Canvasの指定領域をデータURLとして取得
    // multiplier: 1 で見た目通りの解像度で取得（Retina対応は無効化して座標ズレを防ぐ）
    const dataUrl = canvas.toDataURL({
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        format: 'png',
        multiplier: 1,
        enableRetinaScaling: false 
    });

    // 取得したら自分を表示に戻す
    obj.visible = originalVisible;

    const img = new Image();
    img.src = dataUrl;
    img.onload = () => {
        // ピクセル化処理
        const mosaicSize = obj.mosaicSize || 10;
        const w = rect.width;
        const h = rect.height;
        
        // 小さなCanvasで縮小
        const tempCanvas = document.createElement('canvas');
        const tCtx = tempCanvas.getContext('2d');
        const smallW = Math.max(1, Math.floor(w / mosaicSize));
        const smallH = Math.max(1, Math.floor(h / mosaicSize));
        
        tempCanvas.width = smallW;
        tempCanvas.height = smallH;
        tCtx.drawImage(img, 0, 0, smallW, smallH);

        // 大きなCanvasで拡大（最近傍補間＝ドット絵っぽくする）
        const finalCanvas = document.createElement('canvas');
        finalCanvas.width = w;
        finalCanvas.height = h;
        const fCtx = finalCanvas.getContext('2d');
        fCtx.imageSmoothingEnabled = false; // アンチエイリアス無効化
        fCtx.drawImage(tempCanvas, 0, 0, tempCanvas.width, tempCanvas.height, 0, 0, w, h);

        // 加工した画像をオブジェクトのElementとしてセット
        // これにより、PatternではなくImageオブジェクトそのものとして振る舞う
        obj.setElement(finalCanvas);
        
        // リサイズなどで引き伸ばされないようにサイズ再設定が必要な場合もあるが
        // setElementは元画像のサイズを使用するため、scaleをリセットする必要があるかも
        // ここでは「見た目のサイズ」を変えずに中身だけ入れ替えたい
        
        // Canvas上での描画を更新
        canvas.requestRenderAll();
    };
  }, []);

  // --------------------------------------------------------------------------
  // Initialization & Events
  // --------------------------------------------------------------------------

  // テキスト入力エリアの位置固定（スクロール防止の決定打）
  const fixHiddenTextarea = useCallback(() => {
    const c = fabricCanvas.current;
    if (!c) return;
    // hiddenTextareaが存在する場合、強制的にスタイルを適用
    // Fabric.jsのバージョンによってはクラス名やプロパティが違うことがあるので
    // 直接DOM要素を操作する
    const textareas = c.wrapperEl?.parentNode?.getElementsByTagName('textarea');
    if (textareas && textareas.length > 0) {
        for (let i = 0; i < textareas.length; i++) {
            const t = textareas[i];
            t.style.position = 'fixed';
            t.style.top = '0px';
            t.style.left = '0px';
            t.style.opacity = '0';
            t.style.zIndex = '-1';
            // フォーカス時にズームしないようにフォントサイズ調整なども有効だが今回は省略
        }
    }
  }, []);

  useEffect(() => {
    if (scriptsLoaded && canvasRef.current && !fabricCanvas.current) {
      fabricCanvas.current = new window.fabric.Canvas(canvasRef.current, {
        width: 800,
        height: 600,
        backgroundColor: '#ffffff',
        preserveObjectStacking: true, 
        uniformScaling: false, 
        selection: true
      });

      // テキスト編集開始時にスクロール位置を修正
      fabricCanvas.current.on('text:editing:entered', () => {
          const x = window.scrollX;
          const y = window.scrollY;
          fixHiddenTextarea();
          // 少し遅延させて位置を戻す（ブラウザの自動スクロールを打ち消す）
          setTimeout(() => window.scrollTo(x, y), 0);
      });
    }
  }, [scriptsLoaded, fixHiddenTextarea]);

  // イベントリスナー
  useEffect(() => {
    if (!fabricCanvas.current) return;
    const canvas = fabricCanvas.current;

    const handleSave = () => saveCurrentState();
    
    const handleSelection = (e) => {
        const sel = e.selected ? e.selected[0] : null;
        if(sel) syncProperties(sel);
    };

    // モザイク更新トリガー
    const handleModified = (e) => {
        const t = e?.target;
        if (t?.isMosaic) {
            // 移動やリサイズが終わったタイミングでモザイク画像を再生成
            updateMosaicContent(t);
        }
        saveCurrentState();
    };

    const handleObjectAdded = (e) => {
        const t = e?.target;
        if (t?.isMosaic) {
            // 追加直後にモザイク生成
            setTimeout(() => updateMosaicContent(t), 50);
        }
        saveCurrentState();
    };

    canvas.on('object:added', handleObjectAdded);
    canvas.on('object:removed', handleSave);
    canvas.on('object:modified', handleModified);
    canvas.on('text:editing:exited', handleSave);
    canvas.on('selection:created', handleSelection);
    canvas.on('selection:updated', handleSelection);

    return () => {
      canvas.off('object:added', handleObjectAdded);
      canvas.off('object:removed', handleSave);
      canvas.off('object:modified', handleModified);
      canvas.off('text:editing:exited', handleSave);
      canvas.off('selection:created', handleSelection);
      canvas.off('selection:updated', handleSelection);
    };
  }, [saveCurrentState, syncProperties, updateMosaicContent]);

  useEffect(() => {
    const container = workspaceRef.current;
    if (!container) return;
    const handleWheel = (e) => {
      if (e.target.closest('.canvas-container')) {
        e.preventDefault();
        const delta = -e.deltaY * 0.001;
        setZoomLevel(prev => Math.min(Math.max(0.1, prev + delta), 5));
      }
    };
    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => container.removeEventListener('wheel', handleWheel);
  }, []);

  // --------------------------------------------------------------------------
  // Canvas Fit & Load
  // --------------------------------------------------------------------------

  const fitZoom = useCallback(() => {
    if (!workspaceRef.current || currentIndex === -1 || !pages[currentIndex] || !fabricCanvas.current) return;
    const page = pages[currentIndex];
    const isRotated = page.rotation % 180 !== 0;
    const canvasW = isRotated ? page.height : page.width;
    const canvasH = isRotated ? page.width : page.height;
    const containerW = workspaceRef.current.clientWidth - 60;
    const containerH = workspaceRef.current.clientHeight - 60;
    if (canvasW === 0 || canvasH === 0) return;
    const scale = Math.min(containerW / canvasW, containerH / canvasH, 0.9);
    setZoomLevel(Number.isFinite(scale) && scale > 0 ? scale : 0.5);
  }, [currentIndex, pages]);

  useEffect(() => {
    const page = pages[currentIndex];
    if (!fabricCanvas.current || !page) return;
    isUpdatingRef.current = true;

    const isRotated = page.rotation % 180 !== 0;
    const cw = isRotated ? page.height : page.width;
    const ch = isRotated ? page.width : page.height;

    fabricCanvas.current.setDimensions({ width: cw, height: ch });
    fabricCanvas.current.clear();

    const loadObjects = () => {
      if (page.fabricData) {
        fabricCanvas.current.loadFromJSON(page.fabricData, async () => {
          // ロード完了後、モザイク画像を再生成
          // (JSONには画像データが含まれていない場合があるため)
          const objects = fabricCanvas.current.getObjects();
          for (const obj of objects) {
              if (obj.isMosaic) {
                  // 少し待ってから描画しないと背景がロードされていない可能性がある
                  setTimeout(() => updateMosaicContent(obj), 100);
              }
          }
          fabricCanvas.current.requestRenderAll();
          isUpdatingRef.current = false;
        });
      } else {
        isUpdatingRef.current = false;
      }
    };

    if (page.thumb) {
      window.fabric.Image.fromURL(page.thumb, (img) => {
        if (!fabricCanvas.current) return;
        img.set({
          originX: 'center', originY: 'center',
          left: cw / 2, top: ch / 2,
          angle: page.rotation,
          selectable: false, evented: false,
        });
        const scale = Math.max(cw / (isRotated ? img.height : img.width), ch / (isRotated ? img.width : img.height));
        img.scale(scale);
        fabricCanvas.current.setBackgroundImage(img, () => {
          fabricCanvas.current.requestRenderAll();
          loadObjects();
        });
      });
    } else {
      fabricCanvas.current.backgroundColor = '#ffffff';
      fabricCanvas.current.requestRenderAll();
      loadObjects();
    }
    setTimeout(fitZoom, 50);
  }, [currentIndex, pages[currentIndex]?.id, pages[currentIndex]?.rotation, updateMosaicContent]);

  // --------------------------------------------------------------------------
  // Actions
  // --------------------------------------------------------------------------

  const handleFileUpload = async (e) => {
    const files = Array.from(e.target.files);
    if (!files.length) return;
    setIsLoading(true);
    try {
      const pdfjsLib = window.pdfjsLib;
      pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;
      const newPages = [];
      for (const file of files) {
        const arrayBuffer = await file.arrayBuffer();
        const pdfJsBuffer = arrayBuffer.slice(0);
        const pdf = await pdfjsLib.getDocument({ data: pdfJsBuffer }).promise;
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const viewport = page.getViewport({ scale: 2.0 });
          const canvas = document.createElement('canvas');
          const context = canvas.getContext('2d');
          canvas.height = viewport.height;
          canvas.width = viewport.width;
          await page.render({ canvasContext: context, viewport }).promise;
          newPages.push({
            id: Math.random().toString(36).substr(2, 9),
            pdfBytes: arrayBuffer,
            pageNum: i,
            thumb: canvas.toDataURL('image/png'),
            fabricData: null,
            width: viewport.width,
            height: viewport.height,
            rotation: 0
          });
        }
      }
      setPages(prev => {
        const updated = [...prev, ...newPages];
        if (currentIndex === -1 && updated.length > 0) setCurrentIndex(0);
        return updated;
      });
    } catch (err) {
      alert("PDF読み込みに失敗しました");
    } finally {
      setIsLoading(false);
      e.target.value = '';
    }
  };

  const addBlankPage = () => {
    const width = 1240;
    const height = 1754;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, width, height);
    const newPage = {
      id: Math.random().toString(36).substr(2, 9),
      pdfBytes: null,
      pageNum: 0,
      thumb: canvas.toDataURL('image/png'),
      fabricData: null,
      width, height, rotation: 0
    };
    setPages(prev => [...prev, newPage]);
    if (currentIndex === -1) setCurrentIndex(0);
  };

  const handleImageUpload = (e) => {
    const files = Array.from(e.target.files);
    if (!files.length) return;
    
    if (!fabricCanvas.current || currentIndex === -1) {
        alert("画像を挿入するページを選択してください。");
        e.target.value = '';
        return;
    }

    files.forEach((file, index) => {
        const reader = new FileReader();
        reader.onload = (f) => {
            const imgObj = new Image();
            imgObj.src = f.target.result;
            imgObj.onload = () => {
                if (!fabricCanvas.current) return;
                const imgInstance = new window.fabric.Image(imgObj);
                const canvas = fabricCanvas.current;
                
                const scale = Math.min(
                    (canvas.width * 0.4) / imgInstance.width, 
                    (canvas.height * 0.4) / imgInstance.height, 
                    1
                );
                
                imgInstance.scale(scale);
                const center = canvas.getVpCenter();
                const offset = index * 20;
                
                imgInstance.set({ 
                    left: center.x + offset, 
                    top: center.y + offset, 
                    originX: 'center', 
                    originY: 'center',
                    cornerColor: '#3b82f6', 
                    cornerStyle: 'circle', 
                    borderColor: '#3b82f6', 
                    transparentCorners: false,
                    lockUniScaling: true, 
                });
                
                canvas.add(imgInstance);
                if (index === files.length - 1) {
                    canvas.setActiveObject(imgInstance);
                    canvas.requestRenderAll();
                    setTool('select');
                    saveCurrentState();
                }
            };
        };
        reader.readAsDataURL(file);
    });
    e.target.value = '';
  };

  const addShape = (type) => {
    if (!fabricCanvas.current || currentIndex === -1) return;
    setTool(type);
    const canvas = fabricCanvas.current;
    const center = canvas.getVpCenter();
    let obj;
    const commonProps = {
      left: center.x, top: center.y, originX: 'center', originY: 'center',
      opacity: properties.opacity, lockUniScaling: false
    };

    switch (type) {
      case 'rect':
        obj = new window.fabric.Rect({
          ...commonProps, fill: properties.color, width: 200, height: 200,
          strokeUniform: true
        });
        break;
      case 'rect-outline':
        obj = new window.fabric.Rect({
          ...commonProps, fill: 'transparent', stroke: properties.color, strokeWidth: properties.size,
          width: 200, height: 200,
          strokeUniform: true
        });
        break;
      case 'arrow':
        obj = new window.fabric.Path('M 0 0 L 200 200 M 160 185 L 200 200 L 185 160', {
          ...commonProps, stroke: properties.color, strokeWidth: properties.size, fill: 'transparent',
          strokeUniform: true
        });
        break;
      case 'text':
        obj = new window.fabric.IText('テキスト', {
          ...commonProps, fill: properties.color, fontSize: properties.size * 4
        });
        break;
      case 'mosaic':
        // モザイクは最初は「枠線付きの画像」として生成する
        // 中身は透明だが、生成直後に updateMosaicContent が呼ばれて画像化される
        const mosaicCanvas = document.createElement('canvas');
        mosaicCanvas.width = 200; mosaicCanvas.height = 120;
        
        obj = new window.fabric.Image(mosaicCanvas, {
          ...commonProps, 
          width: 200, height: 120, 
          isMosaic: true,
          mosaicSize: properties.size,
          stroke: '#3b82f6', strokeDashArray: [6, 4], strokeWidth: 2,
          fill: 'transparent' // Imageには効かないが一応
        });
        break;
      default: return;
    }
    canvas.add(obj);
    canvas.setActiveObject(obj);
    canvas.renderAll();
    saveCurrentState();
  };

  const updateSelectedObject = (key, value) => {
    const newProps = { ...properties, [key]: value };
    setProperties(newProps);
    const canvas = fabricCanvas.current;
    if (!canvas) return;
    const active = canvas.getActiveObject();
    if (!active) return;

    const objects = active.type === 'activeSelection' ? active.getObjects() : [active];

    objects.forEach(obj => {
        if (key === 'color') {
          if (obj.fill !== 'transparent' && !obj.isMosaic && obj.type !== 'image') obj.set('fill', value);
          if (obj.stroke && obj.stroke !== 'transparent') obj.set('stroke', value);
          if (obj.type === 'i-text') obj.set('fill', value);
        }
        if (key === 'opacity') obj.set('opacity', parseFloat(value));
        if (key === 'size') {
            const val = parseInt(value);
            if (obj.isMosaic) {
                obj.set('mosaicSize', val);
                updateMosaicContent(obj);
            } else if (obj.type === 'i-text') {
                obj.set('fontSize', val * 4);
            } else if (obj.stroke) {
                obj.set('strokeWidth', val);
            }
        }
    });
    
    canvas.requestRenderAll();
    saveCurrentState();
  };

  // レイヤー操作関数
  const moveLayer = (direction) => {
    const canvas = fabricCanvas.current;
    if (!canvas) return;
    const active = canvas.getActiveObject();
    if (!active) return;

    switch (direction) {
      case 'front': canvas.bringToFront(active); break;
      case 'back': canvas.sendToBack(active); break;
      case 'forward': canvas.bringForward(active); break;
      case 'backward': canvas.sendBackwards(active); break;
      default: break;
    }
    canvas.requestRenderAll();
    saveCurrentState();
  };

  // ページ移動関数
  const movePage = (fromIndex, direction) => {
    saveCurrentState(); // 移動前に保存
    const toIndex = fromIndex + direction;
    if (toIndex < 0 || toIndex >= pages.length) return;
    
    setPages(prev => {
        const newPages = [...prev];
        const item = newPages.splice(fromIndex, 1)[0];
        newPages.splice(toIndex, 0, item);
        return newPages;
    });
    
    if (currentIndex === fromIndex) {
        setCurrentIndex(toIndex);
    } else if (currentIndex === toIndex) {
        setCurrentIndex(fromIndex);
    }
  };

  // --------------------------------------------------------------------------
  // Export PDF
  // --------------------------------------------------------------------------

  const exportPDF = async () => {
    if (pages.length === 0) return;
    setIsLoading(true);
    try {
      const { PDFDocument, degrees } = window.PDFLib;
      const mergedPdf = await PDFDocument.create();
      const pdfCache = new Map();

      for (const pageData of pages) {
        let pdfPage;
        if (pageData.pdfBytes) {
          let srcDoc = pdfCache.get(pageData.pdfBytes);
          if (!srcDoc) {
            srcDoc = await PDFDocument.load(pageData.pdfBytes);
            pdfCache.set(pageData.pdfBytes, srcDoc);
          }
          const [copied] = await mergedPdf.copyPages(srcDoc, [pageData.pageNum - 1]);
          pdfPage = mergedPdf.addPage(copied);
        } else {
          pdfPage = mergedPdf.addPage([pageData.width, pageData.height]);
        }

        const currentRot = pdfPage.getRotation().angle;
        pdfPage.setRotation(degrees(currentRot + pageData.rotation));

        const isRotated = pageData.rotation % 180 !== 0;
        const { width: pdfWidth, height: pdfHeight } = pdfPage.getSize();
        
        const overlayCanvas = document.createElement('canvas');
        const fabricWidth = isRotated ? pageData.height : pageData.width;
        const fabricHeight = isRotated ? pageData.width : pageData.height;

        overlayCanvas.width = fabricWidth;
        overlayCanvas.height = fabricHeight;
        
        const staticFabric = new window.fabric.StaticCanvas(overlayCanvas, {
            enableRetinaScaling: false
        });
        
        // 背景設定
        if (pageData.thumb) {
            await new Promise(resolve => {
                window.fabric.Image.fromURL(pageData.thumb, (img) => {
                    img.set({
                        originX: 'center', originY: 'center',
                        left: overlayCanvas.width / 2, top: overlayCanvas.height / 2,
                        angle: pageData.rotation
                    });
                    const scale = Math.max(
                        overlayCanvas.width / (isRotated ? img.height : img.width),
                        overlayCanvas.height / (isRotated ? img.width : img.height)
                    );
                    img.scale(scale);
                    staticFabric.setBackgroundImage(img, resolve);
                });
            });
        }

        // オブジェクト復元
        if (pageData.fabricData) {
          await new Promise(resolve => {
             staticFabric.loadFromJSON(pageData.fabricData, async () => {
                // 静的キャンバス上でもモザイク画像を再生成する
                const objects = staticFabric.getObjects();
                for(const obj of objects) {
                    if (obj.isMosaic) {
                        // モザイク更新処理（アプリ側と同じロジックをStaticCanvasで実行）
                        const bg = staticFabric.backgroundImage;
                        if(bg) {
                            // 編集用枠線は消す
                            obj.set({ stroke: 'transparent' });
                            
                            // 背景画像から切り出し
                            const rect = obj.getBoundingRect(true);
                            // StaticCanvas全体を描画してキャプチャ
                            staticFabric.renderAll();
                            const dataUrl = staticFabric.toDataURL({
                                left: rect.left, top: rect.top,
                                width: rect.width, height: rect.height,
                                format: 'png', multiplier: 1, enableRetinaScaling: false
                            });
                            
                            await new Promise(resImg => {
                                const img = new Image();
                                img.src = dataUrl;
                                img.onload = () => {
                                    const mosaicSize = obj.mosaicSize || 10;
                                    const tempCanvas = document.createElement('canvas');
                                    const tCtx = tempCanvas.getContext('2d');
                                    const sw = Math.max(1, Math.floor(rect.width / mosaicSize));
                                    const sh = Math.max(1, Math.floor(rect.height / mosaicSize));
                                    tempCanvas.width = sw; tempCanvas.height = sh;
                                    tCtx.drawImage(img, 0, 0, sw, sh);
                                    
                                    const finalCanvas = document.createElement('canvas');
                                    finalCanvas.width = rect.width; finalCanvas.height = rect.height;
                                    const fCtx = finalCanvas.getContext('2d');
                                    fCtx.imageSmoothingEnabled = false;
                                    fCtx.drawImage(tempCanvas, 0, 0, sw, sh, 0, 0, rect.width, rect.height);
                                    
                                    obj.setElement(finalCanvas);
                                    resImg();
                                };
                            });
                        }
                    }
                }
                staticFabric.renderAll();
                resolve();
             });
          });
        }
        
        // 出力時は背景画像（PDF本体）は二重描画になるので消す
        // ただし、モザイク画像は既にCanvas上に生成されているので残る
        staticFabric.backgroundImage = null;
        staticFabric.renderAll();

        const dataUrl = overlayCanvas.toDataURL('image/png');
        if (dataUrl !== 'data:,') {
          const overlayImg = await mergedPdf.embedPng(dataUrl);
          
          if (pageData.rotation === 0) {
              pdfPage.drawImage(overlayImg, {
                  x: 0, y: 0, width: pdfWidth, height: pdfHeight
              });
          } else {
              const drawW = isRotated ? pdfHeight : pdfWidth;
              const drawH = isRotated ? pdfWidth : pdfHeight;
              
              let x = 0, y = 0;
              const rot = pageData.rotation % 360;
              
              if (rot === 90) { x = pdfWidth; y = 0; } 
              else if (rot === 180) { x = pdfWidth; y = pdfHeight; } 
              else if (rot === 270) { x = 0; y = pdfHeight; }
              
              pdfPage.drawImage(overlayImg, {
                  x: x, y: y, width: drawW, height: drawH,
                  rotate: degrees(rot),
              });
          }
        }
        staticFabric.dispose();
      }

      const bytes = await mergedPdf.save();
      const blob = new Blob([bytes], { type: 'application/pdf' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = "edited_merged.pdf";
      link.click();
    } catch (err) {
      console.error(err);
      alert("PDF生成エラー: " + err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const ToolButton = ({ name, icon: Icon, isActive, onClick, className = '', disabled = false }) => (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`
        flex flex-col items-center justify-center p-2 rounded-xl transition-all duration-200 min-w-[60px] h-[60px]
        ${isActive 
          ? 'bg-blue-50 text-blue-600 shadow-sm border border-blue-100 transform scale-105' 
          : 'text-slate-500 hover:bg-slate-50 hover:text-slate-700'
        }
        ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
        ${className}
      `}
      title={name}
    >
      <Icon size={20} strokeWidth={isActive ? 2.5 : 2} />
      <span className="text-[9px] font-bold mt-1 tracking-wide">{name}</span>
    </button>
  );

  return (
    <div className="flex h-screen flex-col bg-slate-100 text-slate-900 md:flex-row overflow-hidden font-sans">
      <aside className="w-full border-r bg-white p-4 md:w-72 flex flex-col h-full shadow-[4px_0_24px_rgba(0,0,0,0.02)] z-20">
        <div className="mb-6 space-y-3">
          <h2 className="text-lg font-bold flex items-center gap-2 text-slate-800 px-1">
            <Layers className="h-5 w-5 text-blue-600" />
            ページ構成
          </h2>
          <div className="grid grid-cols-2 gap-2">
            <button onClick={() => fileInputRef.current.click()} className="flex items-center justify-center gap-2 rounded-xl bg-blue-600 py-3 text-xs font-bold text-white hover:bg-blue-700 transition-all shadow-md hover:shadow-lg active:scale-95">
              <FilePlus size={16} /> PDF追加
            </button>
            <button onClick={addBlankPage} className="flex items-center justify-center gap-2 rounded-xl bg-slate-100 py-3 text-xs font-bold text-slate-600 hover:bg-slate-200 transition-all border border-slate-200 active:scale-95">
              <File size={16} /> 白紙追加
            </button>
          </div>
          <input type="file" ref={fileInputRef} onChange={handleFileUpload} multiple accept=".pdf" className="hidden" />
        </div>

        <div className="flex-1 overflow-y-auto pr-2 space-y-3 custom-scrollbar">
          {pages.map((page, idx) => (
            <div 
              key={page.id}
              draggable
              onDragStart={() => setDraggedIndex(idx)}
              onDragOver={(e) => {
                e.preventDefault();
                setDropTargetIndex(idx);
              }}
              onDragLeave={() => setDropTargetIndex(null)}
              onDrop={(e) => {
                e.preventDefault();
                if (draggedIndex === null) return;
                const newPages = [...pages];
                const item = newPages.splice(draggedIndex, 1)[0];
                newPages.splice(idx, 0, item);
                setPages(newPages);
                setDraggedIndex(null);
                setDropTargetIndex(null);
              }}
              onClick={() => setCurrentIndex(idx)}
              className={`group relative flex gap-3 rounded-xl border-2 p-2 cursor-pointer transition-all duration-200 ${
                currentIndex === idx 
                  ? 'border-blue-500 bg-blue-50/50 shadow-md ring-2 ring-blue-100' 
                  : 'border-transparent bg-slate-50 hover:bg-slate-100 hover:border-slate-200'
              }`}
            >
              {dropTargetIndex === idx && draggedIndex !== idx && (
                <div className="absolute -top-1.5 left-0 right-0 h-1 bg-blue-500 rounded-full z-50 pointer-events-none" />
              )}
              
              <div className="flex flex-col items-center justify-between py-1 text-slate-400 w-6">
                <span className="text-xs font-bold text-slate-500">{idx + 1}</span>
                <div className="flex flex-col gap-1 mt-2">
                    <button onClick={(e) => { e.stopPropagation(); movePage(idx, -1); }} disabled={idx === 0} className="p-0.5 hover:bg-slate-200 rounded disabled:opacity-30"><ChevronUp size={14}/></button>
                    <button onClick={(e) => { e.stopPropagation(); movePage(idx, 1); }} disabled={idx === pages.length - 1} className="p-0.5 hover:bg-slate-200 rounded disabled:opacity-30"><ChevronDown size={14}/></button>
                </div>
              </div>
              
              <div className="relative flex-1 bg-white rounded-lg shadow-sm overflow-hidden aspect-[210/297] border border-slate-100">
                <img 
                  src={page.thumb} 
                  className="h-full w-full object-contain" 
                  style={{ transform: `rotate(${page.rotation}deg)` }} 
                  alt={`Page ${idx+1}`} 
                />
              </div>
              
              <div className="flex flex-col gap-1.5 justify-center absolute right-1.5 top-1.5 bottom-1.5 opacity-0 group-hover:opacity-100 transition-all duration-200 translate-x-2 group-hover:translate-x-0">
                <button onClick={(e) => { e.stopPropagation(); setPages(p => p.map((pg, i) => i === idx ? { ...pg, rotation: (pg.rotation + 90) % 360 } : pg)); }} className="p-1.5 bg-white/90 border rounded-md shadow-sm hover:text-blue-600 hover:scale-105 backdrop-blur-sm transition-all" title="回転"><RotateCw size={14}/></button>
                <button onClick={(e) => { e.stopPropagation(); setPages(p => p.filter((_, i) => i !== idx)); }} className="p-1.5 bg-white/90 border rounded-md shadow-sm hover:text-red-600 hover:scale-105 backdrop-blur-sm transition-all" title="削除"><Trash2 size={14}/></button>
              </div>
            </div>
          ))}
        </div>

        <button onClick={exportPDF} disabled={pages.length === 0 || isLoading} className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-slate-800 py-3.5 font-bold text-white hover:bg-slate-900 disabled:opacity-50 disabled:cursor-not-allowed shadow-lg hover:shadow-xl active:scale-95 transition-all text-sm tracking-wide">
          {isLoading ? <Loader2 className="animate-spin" /> : <Download size={20} />}
          統合して保存
        </button>
      </aside>

      <main className="relative flex flex-1 flex-col overflow-hidden bg-slate-100">
        {/* ツールバー */}
        <div className="bg-white shadow-sm border-b border-slate-200 z-30">
          <div className="flex items-center px-4 py-2 overflow-x-auto whitespace-nowrap min-h-[88px] custom-scrollbar">
            
            {/* 基本ツール */}
            <div className="flex gap-1 pr-4 border-r border-slate-100 mr-4">
              <ToolButton name="選択" icon={MousePointer2} isActive={tool === 'select'} onClick={() => setTool('select')} />
            </div>

            {/* 図形・描画 */}
            <div className="flex gap-1 pr-4 border-r border-slate-100 mr-4">
              <ToolButton name="塗りつぶし" icon={Square} isActive={false} onClick={() => addShape('rect')} />
              <ToolButton name="枠線" icon={RectangleHorizontal} isActive={false} onClick={() => addShape('rect-outline')} />
              <ToolButton name="矢印" icon={ArrowUpRight} isActive={false} onClick={() => addShape('arrow')} />
              <ToolButton name="テキスト" icon={Type} isActive={false} onClick={() => addShape('text')} />
            </div>

            {/* 素材・効果 */}
            <div className="flex gap-1 pr-4 border-r border-slate-100 mr-4">
              <ToolButton name="モザイク" icon={Grid} isActive={false} onClick={() => addShape('mosaic')} className="text-blue-600 bg-blue-50/50" />
              <ToolButton name="画像挿入" icon={ImageIcon} isActive={false} onClick={() => imageInputRef.current.click()} />
            </div>

            {/* レイヤー操作 */}
            {currentIndex !== -1 && (
              <div className="flex gap-1 pr-4 border-r border-slate-100 mr-4">
                <ToolButton name="最前面" icon={BringToFront} onClick={() => moveLayer('front')} />
                <ToolButton name="前面" icon={ArrowUp} onClick={() => moveLayer('forward')} />
                <ToolButton name="背面" icon={ArrowDown} onClick={() => moveLayer('backward')} />
                <ToolButton name="最背面" icon={SendToBack} onClick={() => moveLayer('back')} />
              </div>
            )}
            
            <input type="file" ref={imageInputRef} onChange={handleImageUpload} accept="image/*" multiple className="hidden" />

            {/* 削除 */}
            {currentIndex !== -1 && (
              <div className="flex ml-auto pl-4 border-l border-slate-100">
                <ToolButton 
                  name="削除" 
                  icon={Eraser} 
                  isActive={false} 
                  onClick={() => { 
                      const active = fabricCanvas.current.getActiveObject();
                      if(active?.type === 'activeSelection') {
                          active.forEachObject(obj => fabricCanvas.current.remove(obj));
                          fabricCanvas.current.discardActiveObject();
                      } else {
                          fabricCanvas.current.remove(active); 
                      }
                      fabricCanvas.current.requestRenderAll(); 
                      saveCurrentState(); 
                  }} 
                  className="text-red-500 hover:bg-red-50 hover:text-red-600"
                />
              </div>
            )}
          </div>

          {/* プロパティバー */}
          {currentIndex !== -1 && (
            <div className="flex flex-col md:flex-row items-center gap-4 px-6 py-2.5 bg-slate-50/90 backdrop-blur-sm border-b border-slate-200 text-sm overflow-x-auto h-[50px]">
              
              {/* カラーパレット */}
              <div className="flex items-center gap-3">
                <div className="flex gap-2 items-center bg-white p-1 rounded-full border border-slate-200 shadow-sm">
                  {presetColors.map(c => (
                    <button 
                      key={c} 
                      onMouseDown={() => updateSelectedObject('color', c)}
                      className={`w-5 h-5 rounded-full transition-transform hover:scale-110 focus:outline-none ${properties.color === c ? 'ring-2 ring-offset-1 ring-blue-500 scale-110' : ''}`}
                      style={{ backgroundColor: c }}
                    />
                  ))}
                  <div className="w-px h-3 bg-slate-200 mx-1"></div>
                  <div className="relative w-5 h-5">
                    <button className="w-5 h-5 rounded-full bg-gradient-to-br from-pink-500 via-red-500 to-yellow-500 flex items-center justify-center shadow-sm hover:opacity-90"><Pipette size={10} className="text-white" /></button>
                    <input type="color" value={properties.color} onChange={(e) => updateSelectedObject('color', e.target.value)} className="absolute inset-0 opacity-0 cursor-pointer" />
                  </div>
                </div>
              </div>

              <div className="hidden md:block w-px h-5 bg-slate-300/50"></div>

              {/* サイズスライダー */}
              <div className="flex items-center gap-3 bg-white px-3 py-1 rounded-full border border-slate-200 shadow-sm">
                <Sliders size={12} className="text-slate-400" />
                <span className="text-[10px] font-bold text-slate-500 whitespace-nowrap">サイズ</span>
                <input 
                  type="range" 
                  min="1" max="100" 
                  value={properties.size} 
                  onInput={(e) => updateSelectedObject('size', e.target.value)} 
                  className="w-20 h-1.5 accent-blue-600 bg-slate-200 rounded-lg cursor-pointer" 
                />
                <span className="text-[10px] font-mono w-6 text-right">{properties.size}</span>
              </div>

              {/* 透明度スライダー */}
              <div className="flex items-center gap-3 bg-white px-3 py-1 rounded-full border border-slate-200 shadow-sm">
                <div className="w-3 h-3 rounded border border-slate-400 bg-slate-200"></div>
                <span className="text-[10px] font-bold text-slate-500 whitespace-nowrap">透明度</span>
                <input 
                  type="range" 
                  min="0.1" max="1" step="0.05" 
                  value={properties.opacity} 
                  onInput={(e) => updateSelectedObject('opacity', e.target.value)} 
                  className="w-20 h-1.5 accent-blue-600 bg-slate-200 rounded-lg cursor-pointer" 
                />
                <span className="text-[10px] font-mono w-8 text-right">{Math.round(properties.opacity * 100)}%</span>
              </div>

              <div className="flex-1"></div>

              {/* ズームコントロール */}
              <div className="flex items-center gap-1 bg-white rounded-lg border border-slate-200 shadow-sm p-1 ml-auto">
                <button onClick={() => setZoomLevel(prev => Math.max(0.1, prev - 0.1))} className="p-1 hover:bg-slate-50 rounded-md text-slate-500"><ZoomOut size={14}/></button>
                <span className="text-[10px] font-mono w-8 text-center font-bold text-slate-600">{Math.round(zoomLevel * 100)}%</span>
                <button onClick={() => setZoomLevel(prev => Math.min(5, prev + 0.1))} className="p-1 hover:bg-slate-50 rounded-md text-slate-500"><ZoomIn size={14}/></button>
                <div className="w-px h-3 bg-slate-200 mx-1"></div>
                <button onClick={fitZoom} className="p-1 hover:bg-slate-50 rounded-md text-slate-500" title="フィット"><Maximize size={14}/></button>
              </div>
            </div>
          )}
        </div>

        {/* ワークスペース */}
        <div 
          ref={workspaceRef} 
          className="canvas-container flex-1 overflow-hidden relative flex flex-col items-center justify-center bg-slate-200/50"
          style={{ 
            backgroundImage: 'radial-gradient(#cbd5e1 1.5px, transparent 1.5px)', 
            backgroundSize: '24px 24px' 
          }}
        >
          <div 
            className={`transition-all duration-200 ease-out origin-center ${currentIndex === -1 ? 'opacity-0 scale-95' : 'opacity-100 scale-100'}`}
            style={{ 
              transform: `scale(${zoomLevel})`,
            }}
          >
            {/* 物理的な紙のような浮き出し効果 */}
            <div 
              className="bg-white shadow-[0_20px_60px_-15px_rgba(0,0,0,0.3),0_0_0_1px_rgba(0,0,0,0.05)]"
              style={{ width: 'fit-content', height: 'fit-content' }}
            >
               <canvas ref={canvasRef} />
            </div>
          </div>
          
          {currentIndex === -1 && !isLoading && (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-400 animate-in fade-in zoom-in duration-500 pointer-events-none">
              <div className="bg-white/80 backdrop-blur-sm p-12 rounded-[2.5rem] shadow-xl border border-white/50 flex flex-col items-center max-w-md text-center">
                <div className="bg-blue-50 p-4 rounded-full mb-4">
                  <FilePlus size={48} className="text-blue-500" />
                </div>
                <h3 className="text-xl font-bold text-slate-700 mb-2">ファイルを選択してください</h3>
                <p className="text-sm text-slate-500 leading-relaxed">
                  左のメニューからPDFを追加するか、<br/>
                  ファイルをドラッグ＆ドロップしてください。
                </p>
              </div>
            </div>
          )}
          
          {isLoading && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-white/60 backdrop-blur-sm z-50 animate-in fade-in">
              <Loader2 className="animate-spin text-blue-600 h-12 w-12 mb-4" />
              <span className="font-bold text-slate-600 tracking-widest text-sm">PROCESSING...</span>
            </div>
          )}
        </div>
      </main>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar { width: 4px; height: 4px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 10px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #94a3b8; }
        
        input[type="range"]::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          width: 14px;
          height: 14px;
          background: #3b82f6;
          cursor: pointer;
          border-radius: 50%;
          border: 2px solid white;
          box-shadow: 0 1px 3px rgba(0,0,0,0.2);
          transition: transform 0.1s;
        }
        input[type="range"]::-webkit-slider-thumb:hover {
          transform: scale(1.1);
        }
        
        canvas {
          touch-action: none;
          user-select: none;
        }
      `}</style>
    </div>
  );
}
