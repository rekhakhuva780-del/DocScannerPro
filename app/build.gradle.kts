plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.docscanner.pro"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.docscanner.pro"
        minSdk = 24
        targetSdk = 34
        versionCode = 3
        versionName = "2.2"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.mlkit:barcode-scanning:17.2.0")
    implementation("com.google.mlkit:text-recognition:16.0.1")
    implementation("com.google.mlkit:text-recognition-devanagari:16.0.1")
    implementation("cz.adaptech:tesseract4android:4.7.0")
    implementation("com.google.zxing:core:3.5.3")
}
