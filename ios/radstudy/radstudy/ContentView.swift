//
//  ContentView.swift
//  radstudy
//
//  Created by Asahan Sahan on 2026-04-26.
//

import SwiftUI

/// Previous app default; installs that still have this in UserDefaults are migrated once to production.
private let radstudyLegacyLocalDefaultURL = "http://localhost:3110"

struct ContentView: View {
    #if canImport(UIKit)
    @Environment(\.pushNotificationDelegate) private var pushNotificationDelegate
    #endif
    @AppStorage("radstudy_base_url") private var baseURLString = RadstudyServerConfiguration.defaultProductionBaseURL
    @AppStorage("radstudy_admin_cookie") private var adminCookie = ""
    @AppStorage("radstudy_ios_native_secret") private var iosNativeSecret = ""
    /// Optional; when set, push registration prefers this admin email on the server. Leave empty to use first enabled admin.
    @AppStorage("radstudy_push_admin_email") private var pushAdminEmail = ""
    /// Ensures a one-time upgrade from the old localhost default to the production API host.
    @AppStorage("radstudy_api_host_synced_v1") private var didSyncApiHostToProductionDefault = false

    private var serverBaseURL: URL {
        let t = baseURLString.trimmingCharacters(in: .whitespacesAndNewlines)
        if let u = URL(string: t), u.scheme != nil { return u }
        return URL(string: RadstudyServerConfiguration.defaultProductionBaseURL)!
    }

    private var cookieHeader: String? {
        var c = adminCookie.trimmingCharacters(in: .whitespacesAndNewlines)
        if c.localizedCaseInsensitiveContains("cookie:") {
            // Users often paste "Cookie: admin_uid=..." from DevTools; only the name=value part belongs in the header value.
            if let r = c.range(of: "admin_uid=", options: .caseInsensitive) {
                c = String(c[r.lowerBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
            } else if c.lowercased().hasPrefix("cookie:") {
                c = c.dropFirst(7).trimmingCharacters(in: .whitespacesAndNewlines)
            }
        }
        return c.isEmpty ? nil : c
    }

    var body: some View {
        AdminAnalyticsRootView(
            baseURL: serverBaseURL,
            cookieHeader: cookieHeader
        )
        .id("\(baseURLString.trimmingCharacters(in: .whitespacesAndNewlines))|\(adminCookie.count)|\(iosNativeSecret.count)|\(pushAdminEmail.count)")
        .onAppear {
            if !didSyncApiHostToProductionDefault {
                didSyncApiHostToProductionDefault = true
                let trimmed = baseURLString.trimmingCharacters(in: .whitespacesAndNewlines)
                if trimmed == radstudyLegacyLocalDefaultURL {
                    baseURLString = RadstudyServerConfiguration.defaultProductionBaseURL
                }
            }
            print("🌐 [Radstudy] Base URL = \(serverBaseURL.absoluteString)")
            #if canImport(UIKit)
            let email = pushAdminEmail.trimmingCharacters(in: .whitespacesAndNewlines)
            pushNotificationDelegate?.configure(
                baseURL: serverBaseURL,
                adminEmail: email.isEmpty ? nil : email
            )
            pushNotificationDelegate?.requestAuthorization()
            #endif
        }
    }
}

#Preview {
    ContentView()
        #if canImport(UIKit)
        .environment(\.pushNotificationDelegate, nil as PushNotificationManager?)
        #endif
}

#if canImport(UIKit)
private struct PushNotificationDelegateKey: EnvironmentKey {
    static let defaultValue: PushNotificationManager? = nil
}

extension EnvironmentValues {
    /// Single `UIApplicationDelegate` instance from `@UIApplicationDelegateAdaptor` (APNs + notification callbacks).
    var pushNotificationDelegate: PushNotificationManager? {
        get { self[PushNotificationDelegateKey.self] }
        set { self[PushNotificationDelegateKey.self] = newValue }
    }
}
#endif
