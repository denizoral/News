package com.frontierwire.app

import android.app.Application
import com.frontierwire.core.Notify

class WireApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Notify.ensureChannels(this, CHANNELS)
        CheckWorker.schedule(this)
        Devices.register(this)
    }
}
