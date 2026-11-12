import java.util.Properties

plugins { id("com.android.application") }

// Signing: keystore.properties (gitignored) or env vars FS_KEYSTORE / FS_KEYSTORE_PASSWORD.
val ksProps = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}
fun cfg(envName: String, key: String): String? = System.getenv(envName) ?: ksProps.getProperty(key)

android {
    namespace = "ca.firstsounds.tv"
    compileSdk = 36
    defaultConfig {
        applicationId = "ca.firstsounds.tv"
        minSdk = 23
        targetSdk = 36
        versionCode = 2
        versionName = "1.1"
    }
    val ksPath = cfg("FS_KEYSTORE", "storeFile")
    val ksPass = cfg("FS_KEYSTORE_PASSWORD", "storePassword")
    if (ksPath != null && ksPass != null) {
        signingConfigs.create("release") {
            storeFile = file(ksPath)
            storePassword = ksPass
            keyAlias = cfg("FS_KEY_ALIAS", "keyAlias") ?: "firstsounds"
            keyPassword = cfg("FS_KEY_PASSWORD", "keyPassword") ?: ksPass
            enableV1Signing = true
            enableV2Signing = true
        }
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfigs.findByName("release")?.let { signingConfig = it }
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    lint { abortOnError = false }
}
