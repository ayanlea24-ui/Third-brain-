#if canImport(ActivityKit) && canImport(SwiftUI) && canImport(WidgetKit)
import ActivityKit
import SwiftUI
import WidgetKit

/// Lock-screen Live Activity — compact so name, location, school, exam line, and progress all fit typical card height.
struct RadstudyLiveSessionLockScreenView: View {
    let state: RadstudyLiveSessionAttributes.ContentState
    let attributes: RadstudyLiveSessionAttributes

    private static let accent = Color(red: 0.95, green: 0.62, blue: 0.22)
    private static let track = Color.white.opacity(0.18)

    private var displayFullName: String {
        let f = state.learnerFirstName.trimmingCharacters(in: .whitespacesAndNewlines)
        let l = state.learnerLastName.trimmingCharacters(in: .whitespacesAndNewlines)
        let combined = [f, l].filter { !$0.isEmpty }.joined(separator: " ")
        if !combined.isEmpty { return combined }
        let fallback = attributes.learnerName.trimmingCharacters(in: .whitespacesAndNewlines)
        return fallback.isEmpty ? "Learner" : fallback
    }

    private var displayCountry: String {
        state.learnerCountry.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var displayProvince: String {
        state.learnerProvince.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var displaySchool: String {
        state.learnerSchool.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// One line: province · country (or whichever is present).
    private var compactLocationLine: String? {
        let p = displayProvince
        let c = displayCountry
        if !p.isEmpty && !c.isEmpty { return "\(p) · \(c)" }
        if !c.isEmpty { return c }
        if !p.isEmpty { return p }
        return nil
    }

    private var phaseBadge: String {
        switch state.phase {
        case "start": return "LIVE"
        case "progress": return "ACTIVE"
        case "complete": return "DONE"
        default: return "LIVE"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .center, spacing: 6) {
                Text(phaseBadge)
                    .font(.system(size: 9, weight: .bold, design: .rounded))
                    .tracking(0.5)
                    .foregroundStyle(.black.opacity(0.9))
                    .padding(.horizontal, 7)
                    .padding(.vertical, 3)
                    .background(Capsule().fill(Self.accent))
                Spacer(minLength: 0)
                Text(shortSessionId)
                    .font(.system(size: 10, weight: .medium, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.4))
                    .lineLimit(1)
                    .minimumScaleFactor(0.65)
            }

            Text(displayFullName)
                .font(.system(size: 17, weight: .bold, design: .default))
                .foregroundStyle(.white)
                .minimumScaleFactor(0.78)
                .lineLimit(2)
                .padding(.top, 8)

            if let loc = compactLocationLine {
                Label {
                    Text(loc)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(.white.opacity(0.7))
                        .lineLimit(1)
                        .minimumScaleFactor(0.72)
                } icon: {
                    Image(systemName: "globe.americas.fill")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(Self.accent.opacity(0.95))
                }
                .labelStyle(.titleAndIcon)
                .padding(.top, 4)
            }

            if !displaySchool.isEmpty {
                Label {
                    Text(displaySchool)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(.white.opacity(0.7))
                        .lineLimit(1)
                        .minimumScaleFactor(0.68)
                } icon: {
                    Image(systemName: "building.columns.fill")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(Self.accent.opacity(0.95))
                }
                .labelStyle(.titleAndIcon)
                .padding(.top, 3)
            }

            // Badge + subtitle carry phase; skip duplicate uppercase title row to save vertical space.
            Text(state.subtitleText)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.white.opacity(0.9))
                .lineLimit(2)
                .minimumScaleFactor(0.8)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 6)

            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 3) {
                    ForEach(0..<5, id: \.self) { i in
                        Capsule()
                            .fill(i < state.segmentFilled ? Self.accent : Self.track)
                            .frame(maxWidth: .infinity)
                            .frame(height: 5)
                    }
                }

                HStack {
                    Text("\(state.answered)/\(max(state.total, 1))")
                        .font(.system(size: 11, weight: .semibold))
                        .monospacedDigit()
                        .foregroundStyle(.white.opacity(0.82))
                    Spacer(minLength: 0)
                    Text("Radstudy")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(.white.opacity(0.38))
                }
            }
            .padding(.top, 8)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .activityBackgroundTint(Color(red: 0.11, green: 0.06, blue: 0.1).opacity(0.96))
        .activitySystemActionForegroundColor(Color.white)
    }

    private var shortSessionId: String {
        let s = attributes.sessionId
        if s.count <= 10 { return s }
        return String(s.prefix(6)) + "…"
    }
}
#endif
