package com.docscanner.pro

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.CancellationSignal
import android.os.Environment
import android.os.ParcelFileDescriptor
import android.print.PageRange
import android.print.PrintAttributes
import android.print.PrintDocumentAdapter
import android.print.PrintDocumentInfo
import android.print.PrintManager
import android.provider.MediaStore
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.devanagari.DevanagariTextRecognizerOptions
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import com.googlecode.tesseract.android.TessBaseAPI
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private var cameraPhotoUri: Uri? = null

    private val fileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val callback = filePathCallback ?: return@registerForActivityResult
        filePathCallback = null

        if (result.resultCode == Activity.RESULT_OK) {
            val data = result.data
            val uris = mutableListOf<Uri>()
            if (data?.clipData != null) {
                for (i in 0 until data.clipData!!.itemCount) {
                    uris.add(data.clipData!!.getItemAt(i).uri)
                }
            } else if (data?.data != null) {
                uris.add(data.data!!)
            } else if (cameraPhotoUri != null) {
                uris.add(cameraPhotoUri!!)
            }
            callback.onReceiveValue(if (uris.isNotEmpty()) uris.toTypedArray() else null)
        } else {
            callback.onReceiveValue(null)
        }
        cameraPhotoUri = null
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        requestAppPermissions()

        webView = WebView(this)
        setContentView(webView)

        val settings = webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.databaseEnabled = true
        settings.allowFileAccess = true
        settings.mediaPlaybackRequiresUserGesture = false

        webView.addJavascriptInterface(AndroidBridge(), "AndroidBridge")
        webView.webViewClient = WebViewClient()

        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                runOnUiThread {
                    request.grant(request.resources)
                }
            }

            override fun onShowFileChooser(
                webView: WebView?,
                callback: ValueCallback<Array<Uri>>?,
                params: FileChooserParams?
            ): Boolean {
                filePathCallback?.onReceiveValue(null)
                filePathCallback = callback

                val acceptCapture = params?.isCaptureEnabled == true
                return try {
                    if (acceptCapture) {
                        val photoFile = File(getExportDir(), "cam_${System.currentTimeMillis()}.jpg")
                        cameraPhotoUri = FileProvider.getUriForFile(
                            this@MainActivity,
                            "${packageName}.fileprovider",
                            photoFile
                        )
                        val camIntent = Intent(MediaStore.ACTION_IMAGE_CAPTURE).apply {
                            putExtra(MediaStore.EXTRA_OUTPUT, cameraPhotoUri)
                        }
                        fileChooserLauncher.launch(camIntent)
                    } else {
                        val pickIntent = Intent(Intent.ACTION_GET_CONTENT).apply {
                            type = "image/*"
                            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                        }
                        fileChooserLauncher.launch(Intent.createChooser(pickIntent, "Select Document Images"))
                    }
                    true
                } catch (e: Exception) {
                    filePathCallback = null
                    Toast.makeText(this@MainActivity, "Picker error: ${e.message}", Toast.LENGTH_SHORT).show()
                    false
                }
            }
        }

        webView.loadUrl("file:///android_asset/index.html")
    }

    private fun requestAppPermissions() {
        val perms = mutableListOf(Manifest.permission.CAMERA)
        if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.P) {
            perms.add(Manifest.permission.WRITE_EXTERNAL_STORAGE)
        }
        val missing = perms.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isNotEmpty()) {
            ActivityCompat.requestPermissions(this, missing.toTypedArray(), 101)
        }
    }

    private fun getExportDir(): File {
        val dir = File(cacheDir, "exports")
        if (!dir.exists()) dir.mkdirs()
        return dir
    }

    private fun prepareTesseractDataDir(): File {
        val baseDir = File(filesDir, "tesseract")
        val tessDir = File(baseDir, "tessdata")
        if (!tessDir.exists()) tessDir.mkdirs()

        val filesToCopy = listOf("guj.traineddata", "eng.traineddata")
        for (fileName in filesToCopy) {
            val outFile = File(tessDir, fileName)
            if (!outFile.exists() || outFile.length() == 0L) {
                assets.open("tessdata/$fileName").use { input ->
                    FileOutputStream(outFile).use { output ->
                        input.copyTo(output)
                    }
                }
            }
        }
        return baseDir
    }

    inner class AndroidBridge {

        @JavascriptInterface
        fun showToast(message: String) {
            runOnUiThread {
                Toast.makeText(this@MainActivity, message, Toast.LENGTH_SHORT).show()
            }
        }

        @JavascriptInterface
        fun copyToClipboard(text: String) {
            runOnUiThread {
                val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                cm.setPrimaryClip(ClipData.newPlainText("DocScanner OCR", text))
                Toast.makeText(this@MainActivity, "Text clipboard par copy ho gaya", Toast.LENGTH_SHORT).show()
            }
        }

        @JavascriptInterface
        fun toggleFlash(enable: Boolean): Boolean {
            return try {
                val cm = getSystemService(Context.CAMERA_SERVICE) as CameraManager
                val backCamId = cm.cameraIdList.firstOrNull { id ->
                    val chars = cm.getCameraCharacteristics(id)
                    chars.get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true &&
                        chars.get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_BACK
                } ?: return false
                cm.setTorchMode(backCamId, enable)
                true
            } catch (e: Exception) {
                false
            }
        }

        @JavascriptInterface
        fun saveToDevice(base64Data: String, fileName: String, mimeType: String) {
            try {
                val bytes = Base64.decode(base64Data, Base64.DEFAULT)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    val values = ContentValues().apply {
                        put(MediaStore.MediaColumns.DISPLAY_NAME, fileName)
                        put(MediaStore.MediaColumns.MIME_TYPE, mimeType)
                        put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/DocScannerPro")
                    }
                    val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                    if (uri != null) {
                        contentResolver.openOutputStream(uri)?.use { it.write(bytes) }
                    }
                } else {
                    val dir = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "DocScannerPro")
                    if (!dir.exists()) dir.mkdirs()
                    File(dir, fileName).writeBytes(bytes)
                }
                showToast("Saved in Downloads/DocScannerPro/$fileName")
            } catch (e: Exception) {
                showToast("Save failed: ${e.message}")
            }
        }

        @JavascriptInterface
        fun shareFile(base64Data: String, fileName: String, mimeType: String) {
            try {
                val bytes = Base64.decode(base64Data, Base64.DEFAULT)
                val outFile = File(getExportDir(), fileName)
                FileOutputStream(outFile).use { it.write(bytes) }

                val uri = FileProvider.getUriForFile(
                    this@MainActivity,
                    "${packageName}.fileprovider",
                    outFile
                )
                val shareIntent = Intent(Intent.ACTION_SEND).apply {
                    type = mimeType
                    putExtra(Intent.EXTRA_STREAM, uri)
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
                runOnUiThread {
                    startActivity(Intent.createChooser(shareIntent, "Share / Upload to Drive, Dropbox, Fax"))
                }
            } catch (e: Exception) {
                showToast("Share failed: ${e.message}")
            }
        }

        @JavascriptInterface
        fun shareText(text: String) {
            val intent = Intent(Intent.ACTION_SEND).apply {
                type = "text/plain"
                putExtra(Intent.EXTRA_TEXT, text)
            }
            runOnUiThread {
                startActivity(Intent.createChooser(intent, "Share Text"))
            }
        }

        @JavascriptInterface
        fun printPdf(base64Data: String, jobName: String) {
            try {
                val bytes = Base64.decode(base64Data, Base64.DEFAULT)
                val pdfFile = File(getExportDir(), "print_${System.currentTimeMillis()}.pdf")
                FileOutputStream(pdfFile).use { it.write(bytes) }

                runOnUiThread {
                    val printManager = getSystemService(Context.PRINT_SERVICE) as PrintManager
                    val adapter = object : PrintDocumentAdapter() {
                        override fun onLayout(
                            oldAttributes: PrintAttributes?,
                            newAttributes: PrintAttributes?,
                            cancellationSignal: CancellationSignal?,
                            callback: LayoutResultCallback?,
                            extras: Bundle?
                        ) {
                            if (cancellationSignal?.isCanceled == true) {
                                callback?.onLayoutCancelled()
                                return
                            }
                            val info = PrintDocumentInfo.Builder(jobName)
                                .setContentType(PrintDocumentInfo.CONTENT_TYPE_DOCUMENT)
                                .build()
                            callback?.onLayoutFinished(info, true)
                        }

                        override fun onWrite(
                            pages: Array<out PageRange>?,
                            destination: ParcelFileDescriptor?,
                            cancellationSignal: CancellationSignal?,
                            callback: WriteResultCallback?
                        ) {
                            try {
                                FileInputStream(pdfFile).use { input ->
                                    FileOutputStream(destination?.fileDescriptor).use { output ->
                                        input.copyTo(output)
                                    }
                                }
                                callback?.onWriteFinished(arrayOf(PageRange.ALL_PAGES))
                            } catch (e: Exception) {
                                callback?.onWriteFailed(e.message)
                            }
                        }
                    }
                    printManager.print(jobName, adapter, null)
                }
            } catch (e: Exception) {
                showToast("Print error: ${e.message}")
            }
        }

        @JavascriptInterface
        fun scanBarcodeFromBase64(base64Image: String) {
            try {
                val bytes = Base64.decode(base64Image, Base64.DEFAULT)
                val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: return
                val image = InputImage.fromBitmap(bitmap, 0)
                val scanner = BarcodeScanning.getClient()

                scanner.process(image)
                    .addOnSuccessListener { barcodes ->
                        val result = if (barcodes.isNotEmpty()) {
                            barcodes.first().rawValue ?: ""
                        } else {
                            ""
                        }
                        val safeJson = JSONObject.quote(result)
                        webView.post {
                            webView.evaluateJavascript("window.onNativeBarcodeResult($safeJson)", null)
                        }
                    }
                    .addOnFailureListener {
                        webView.post {
                            webView.evaluateJavascript("window.onNativeBarcodeResult('')", null)
                        }
                    }
            } catch (e: Exception) {
                webView.post {
                    webView.evaluateJavascript("window.onNativeBarcodeResult('')", null)
                }
            }
        }

        @JavascriptInterface
        fun runOcrFromBase64(base64Image: String, langMode: String) {
            if (langMode == "gu") {
                Thread {
                    var tess: TessBaseAPI? = null
                    try {
                        val bytes = Base64.decode(base64Image, Base64.DEFAULT)
                        val rawBmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                        if (rawBmp == null) {
                            webView.post {
                                webView.evaluateJavascript("window.onNativeOcrResult('', 'Image read nahi hui')", null)
                            }
                            return@Thread
                        }

                        val argbBmp = if (rawBmp.config == Bitmap.Config.ARGB_8888) {
                            rawBmp
                        } else {
                            rawBmp.copy(Bitmap.Config.ARGB_8888, false)
                        }

                        val dataDir = prepareTesseractDataDir()
                        tess = TessBaseAPI()
                        val initialized = tess.init(dataDir.absolutePath, "guj+eng")
                        if (!initialized) {
                            webView.post {
                                webView.evaluateJavascript("window.onNativeOcrResult('', 'Gujarati OCR init failed')", null)
                            }
                            return@Thread
                        }

                        tess.setPageSegMode(TessBaseAPI.PageSegMode.PSM_AUTO)
                        tess.setImage(argbBmp)
                        val extracted = tess.getUTF8Text() ?: ""
                        val safeText = JSONObject.quote(extracted.trim())
                        webView.post {
                            webView.evaluateJavascript("window.onNativeOcrResult($safeText, '')", null)
                        }
                    } catch (e: Exception) {
                        val err = JSONObject.quote(e.message ?: "Gujarati OCR error")
                        webView.post {
                            webView.evaluateJavascript("window.onNativeOcrResult('', $err)", null)
                        }
                    } finally {
                        try {
                            tess?.recycle()
                        } catch (_: Exception) {
                        }
                    }
                }.start()
                return
            }

            try {
                val bytes = Base64.decode(base64Image, Base64.DEFAULT)
                val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                if (bitmap == null) {
                    webView.post {
                        webView.evaluateJavascript("window.onNativeOcrResult('', 'Image read nahi hui')", null)
                    }
                    return
                }

                val image = InputImage.fromBitmap(bitmap, 0)
                val recognizer = if (langMode == "hi") {
                    TextRecognition.getClient(DevanagariTextRecognizerOptions.Builder().build())
                } else {
                    TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)
                }

                recognizer.process(image)
                    .addOnSuccessListener { visionText ->
                        val safeText = JSONObject.quote(visionText.text)
                        webView.post {
                            webView.evaluateJavascript("window.onNativeOcrResult($safeText, '')", null)
                        }
                    }
                    .addOnFailureListener { e ->
                        val err = JSONObject.quote(e.message ?: "OCR failed")
                        webView.post {
                            webView.evaluateJavascript("window.onNativeOcrResult('', $err)", null)
                        }
                    }
            } catch (e: Exception) {
                val err = JSONObject.quote(e.message ?: "OCR error")
                webView.post {
                    webView.evaluateJavascript("window.onNativeOcrResult('', $err)", null)
                }
            }
        }

        @JavascriptInterface
        fun generateQrCode(text: String): String {
            return try {
                val size = 512
                val matrix = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, size, size)
                val bmp = Bitmap.createBitmap(size, size, Bitmap.Config.RGB_565)
                for (x in 0 until size) {
                    for (y in 0 until size) {
                        bmp.setPixel(x, y, if (matrix[x, y]) Color.BLACK else Color.WHITE)
                    }
                }
                val stream = ByteArrayOutputStream()
                bmp.compress(Bitmap.CompressFormat.PNG, 100, stream)
                "data:image/png;base64," + Base64.encodeToString(stream.toByteArray(), Base64.NO_WRAP)
            } catch (e: Exception) {
                ""
            }
        }
    }
}
