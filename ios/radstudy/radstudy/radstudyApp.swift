//
//  radstudyApp.swift
//  radstudy
//
//  Created by Asahan Sahan on 2026-04-26.
//

import SwiftUI

@main
struct radstudyApp: App {
    #if canImport(UIKit)
    @UIApplicationDelegateAdaptor(PushNotificationManager.self) private var pushDelegate
    #endif

    var body: some Scene {
        WindowGroup {
            ContentView()
                #if canImport(UIKit)
                .environment(\.pushNotificationDelegate, pushDelegate)
                #endif
        }
    }
}
