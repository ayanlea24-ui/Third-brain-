#if canImport(ActivityKit) && canImport(UIKit)
import ActivityKit
import UIKit

/// Starts / updates / ends lock-screen Live Activities from APNs `userInfo` (type `live_session`).
@MainActor
enum RadstudyLiveSessionActivityManager {
    /// Local demo so you can verify the lock screen / Dynamic Island without waiting for APNs.
    static func startSampleLiveActivityForTesting() async {
        let sid = "radstudy-preview-\(Int(Date().timeIntervalSince1970))"
        await apply(from: [
            "type": "live_session",
            "phase": "start",
            "sessionId": sid,
            "learnerName": "Preview learner",
            "learnerFirstName": "Alex",
            "learnerLastName": "Preview",
            "learnerCountry": "United States",
            "learnerProvince": "CA",
            "learnerSchool": "Preview College",
            "examName": "Sample exam",
            "total": 24,
            "totalQuestions": 24,
            "answered": 5,
            "questionsAnswered": 5,
            "scorePercent": 0
        ])
    }

    static func apply(from userInfo: [AnyHashable: Any]) async {
        guard #available(iOS 16.2, *) else { return }
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            print("ℹ️ [Radstudy] Live Activities disabled in Settings (Face ID → Live Activities, or per-app)")
            return
        }

        let type = normalizedString(userInfo["type"])
        guard type == "live_session" else {
            if !type.isEmpty {
                print("ℹ️ [Radstudy] LiveActivity skip: type=\"\(type)\" (need live_session)")
            }
            return
        }

        let phase = normalizedString(userInfo["phase"])
        let sessionId = normalizedString(userInfo["sessionId"])
        guard !sessionId.isEmpty else {
            print("ℹ️ [Radstudy] LiveActivity skip: missing sessionId. userInfo keys: \(userInfo.keys.map { "\($0)" }.sorted().joined(separator: ", "))")
            return
        }

        let answered = intValue(userInfo["questionsAnswered"] ?? userInfo["answered"])
        let total = intValue(userInfo["totalQuestions"] ?? userInfo["total"])
        let score = intValue(userInfo["scorePercent"])
        let exam = normalizedString(userInfo["examName"])
        let learnerFromPayload = normalizedString(userInfo["learnerName"])
        let fn = normalizedString(userInfo["learnerFirstName"])
        let ln = normalizedString(userInfo["learnerLastName"])
        let country = normalizedString(userInfo["learnerCountry"])
        let province = normalizedString(userInfo["learnerProvince"])
        let school = normalizedString(userInfo["learnerSchool"])
        let combinedFL = [fn, ln].filter { !$0.isEmpty }.joined(separator: " ")
        let learner = !combinedFL.isEmpty ? combinedFL : (learnerFromPayload.isEmpty ? "Learner" : learnerFromPayload)

        let segment = segmentFilled(answered: answered, total: total, buckets: 5)

        // titleText / subtitleText power the Live Activity banner — keep learner in name fields only (no repeat).
        let title: String
        let subtitle: String
        switch phase {
        case "start":
            title = "Live session"
            subtitle = exam.isEmpty ? "Quiz underway" : exam
        case "progress":
            title = "In progress"
            if exam.isEmpty {
                subtitle = "\(answered) of \(max(total, 1)) questions"
            } else {
                subtitle = "\(exam) · \(answered)/\(max(total, 1))"
            }
        case "complete":
            title = "Session finished"
            subtitle = exam.isEmpty ? "\(score)% score" : "\(exam) · \(score)%"
        default:
            title = "Radstudy"
            subtitle = phase.isEmpty ? "Live" : phase
        }

        let state = RadstudyLiveSessionAttributes.ContentState(
            phase: phase,
            titleText: title,
            subtitleText: subtitle,
            answered: answered,
            total: total,
            segmentFilled: segment,
            endedScorePercent: phase == "complete" ? score : nil,
            learnerFirstName: fn,
            learnerLastName: ln,
            learnerCountry: country,
            learnerProvince: province,
            learnerSchool: school
        )

        if let existing = Activity<RadstudyLiveSessionAttributes>.activities.first(where: { $0.attributes.sessionId == sessionId }) {
            if phase == "complete" {
                await existing.end(
                    ActivityContent(state: state, staleDate: nil),
                    dismissalPolicy: .default
                )
                print("🔔 [Radstudy] Live Activity ended \(sessionId.prefix(8))…")
            } else {
                await existing.update(ActivityContent(state: state, staleDate: nil))
                print("🔔 [Radstudy] Live Activity updated \(sessionId.prefix(8))… phase=\(phase)")
            }
            return
        }

        if phase == "complete" {
            return
        }

        let attrs = RadstudyLiveSessionAttributes(sessionId: sessionId, learnerName: learner)
        do {
            _ = try Activity.request(
                attributes: attrs,
                content: ActivityContent(state: state, staleDate: nil),
                pushType: nil
            )
            print("🔔 [Radstudy] Live Activity started \(sessionId.prefix(8))…")
        } catch {
            print("❌ [Radstudy] Live Activity request failed: \(error.localizedDescription)")
        }
    }

    private static func segmentFilled(answered: Int, total: Int, buckets: Int) -> Int {
        guard total > 0, buckets > 0 else { return 0 }
        let p = min(1.0, Double(max(0, answered)) / Double(total))
        return min(buckets, max(0, Int(ceil(p * Double(buckets)))))
    }

    private static func normalizedString(_ v: Any?) -> String {
        guard let v else { return "" }
        if let s = v as? String { return s }
        if let s = v as? NSString { return s as String }
        if let n = v as? NSNumber { return n.stringValue }
        if let n = v as? Int { return String(n) }
        return String(describing: v).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func intValue(_ v: Any?) -> Int {
        if let i = v as? Int { return i }
        if let n = v as? NSNumber { return n.intValue }
        if let s = v as? String, let i = Int(s) { return i }
        return 0
    }
}
#endif
