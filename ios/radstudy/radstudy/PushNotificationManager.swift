import Foundation

#if canImport(UIKit)
import UIKit
import UserNotifications
import AudioToolbox
import AVFoundation
#if canImport(ActivityKit)
import ActivityKit
#endif

/// Must be used only as `@UIApplicationDelegateAdaptor` so there is a single instance for APNs + notification delegate callbacks.
final class PushNotificationManager: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    private static let tokenDefaultsKey = "radstudy.apns.deviceToken"
    private static var configuredBaseURL: URL?
    private static var configuredAdminEmail: String?
    private var dramaticPlayer: AVAudioPlayer?

    override init() {
        super.init()
    }

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func configure(baseURL: URL, adminEmail: String?) {
        Self.configuredBaseURL = baseURL
        Self.configuredAdminEmail = adminEmail
        print("🔔 [Radstudy] Push manager configured: \(baseURL.absoluteString)")
        DispatchQueue.main.async {
            UIApplication.shared.registerForRemoteNotifications()
            print("🔔 [Radstudy] Forced remote notification registration on launch")
        }
        Task {
            await resendCachedTokenIfAvailable()
        }
    }

    func requestAuthorization() {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.requestAuthorization(options: [.alert, .badge, .sound]) { granted, error in
            if let error {
                print("❌ [Radstudy] Push auth error: \(error.localizedDescription)")
                return
            }
            print("🔔 [Radstudy] Push permission granted: \(granted)")
            guard granted else { return }
            DispatchQueue.main.async {
                UIApplication.shared.registerForRemoteNotifications()
            }
        }
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        print("✅ [Radstudy] APNs token received: \(token.prefix(16))...")
        print("APNS_DEVICE_TOKEN_FULL=\(token)")
        UserDefaults.standard.set(token, forKey: Self.tokenDefaultsKey)
        Task {
            await registerTokenOnBackend(token: token)
        }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        print("❌ [Radstudy] APNs register failed: \(error.localizedDescription)")
    }

    func application(
        _ application: UIApplication,
        didReceiveRemoteNotification userInfo: [AnyHashable: Any],
        fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
    ) {
        #if canImport(ActivityKit)
        Task { @MainActor in
            await RadstudyLiveSessionActivityManager.apply(from: userInfo)
            completionHandler(.newData)
        }
        #else
        completionHandler(.noData)
        #endif
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        let userInfo = notification.request.content.userInfo
        let type = String(describing: userInfo["type"] ?? "")
        if type == "new_account" || type == "user_login" {
            // Add stronger foreground feedback for account and login notifications.
            AudioServicesPlaySystemSound(kSystemSoundID_Vibrate)
            let feedback = UINotificationFeedbackGenerator()
            feedback.prepare()
            feedback.notificationOccurred(.success)
            playDramaticAlertSound()
        }
        if type == "live_session" {
            let phase = String(describing: userInfo["phase"] ?? "")
            if phase == "start" {
                AudioServicesPlaySystemSound(kSystemSoundID_Vibrate)
                let feedback = UINotificationFeedbackGenerator()
                feedback.prepare()
                feedback.notificationOccurred(.success)
                playDramaticAlertSound()
            } else {
                let impact = UIImpactFeedbackGenerator(style: phase == "complete" ? .heavy : .light)
                impact.prepare()
                impact.impactOccurred()
            }
            #if canImport(ActivityKit)
            Task { @MainActor in
                await RadstudyLiveSessionActivityManager.apply(from: userInfo)
            }
            #endif
        }
        completionHandler([.banner, .sound, .badge])
    }

    /// When the user taps the notification (e.g. from lock screen), `willPresent` is not called — handle Live Activity here too.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let userInfo = response.notification.request.content.userInfo
        #if canImport(ActivityKit)
        Task { @MainActor in
            await RadstudyLiveSessionActivityManager.apply(from: userInfo)
            completionHandler()
        }
        #else
        completionHandler()
        #endif
    }

    private func playDramaticAlertSound() {
        guard let url = Bundle.main.url(forResource: "dramatic_alert", withExtension: "caf") else {
            print("⚠️ [Radstudy] dramatic_alert.caf not found in app bundle")
            return
        }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .default, options: [.duckOthers])
            try session.setActive(true)
            dramaticPlayer = try AVAudioPlayer(contentsOf: url)
            dramaticPlayer?.numberOfLoops = 0
            dramaticPlayer?.prepareToPlay()
            dramaticPlayer?.play()
            print("🔊 [Radstudy] Playing dramatic_alert.caf")
        } catch {
            print("❌ [Radstudy] Failed to play dramatic alert: \(error.localizedDescription)")
        }
    }

    private func registerTokenOnBackend(token: String) async {
        guard let baseURL = Self.configuredBaseURL else {
            print("❌ [Radstudy] Push register skipped: missing baseURL")
            return
        }
        guard let endpoint = URL(string: "/api/ios/push/register-token", relativeTo: baseURL) else {
            return
        }
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let native = UserDefaults.standard.string(forKey: "radstudy_ios_native_secret")?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "\n", with: "")
            .replacingOccurrences(of: "\r", with: "") ?? ""
        if !native.isEmpty {
            request.setValue(native, forHTTPHeaderField: "X-Radstudy-iOS-Secret")
        }
        request.timeoutInterval = 20
        let body: [String: Any] = [
            "token": token,
            "email": Self.configuredAdminEmail ?? "",
            "asAdmin": "true"
        ]
        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body, options: [])
            let (data, response) = try await URLSession.shared.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            let text = String(data: data, encoding: .utf8) ?? ""
            print("🔔 [Radstudy] register-token status \(status): \(text)")
        } catch {
            print("❌ [Radstudy] register-token failed: \(error.localizedDescription)")
        }
    }

    private func resendCachedTokenIfAvailable() async {
        let cached = String(UserDefaults.standard.string(forKey: Self.tokenDefaultsKey) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cached.isEmpty else {
            print("ℹ️ [Radstudy] No cached APNs token yet")
            return
        }
        print("🔁 [Radstudy] Re-sending cached APNs token: \(cached.prefix(16))...")
        await registerTokenOnBackend(token: cached)
    }
}
#endif

