#if canImport(ActivityKit) && canImport(SwiftUI) && canImport(WidgetKit)
import ActivityKit
import SwiftUI
import WidgetKit

struct RadstudyLiveSessionLiveActivityWidget: Widget {
    private static let accent = Color(red: 0.95, green: 0.62, blue: 0.22)

    var body: some WidgetConfiguration {
        ActivityConfiguration(for: RadstudyLiveSessionAttributes.self) { context in
            RadstudyLiveSessionLockScreenView(state: context.state, attributes: context.attributes)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(islandFullName(context))
                            .font(.subheadline.weight(.bold))
                            .foregroundStyle(.primary)
                            .lineLimit(2)
                            .minimumScaleFactor(0.82)
                        if let loc = islandLocationLine(context) {
                            Label(loc, systemImage: "globe.americas.fill")
                                .font(.caption2.weight(.medium))
                                .foregroundStyle(.secondary)
                                .labelStyle(.titleAndIcon)
                                .lineLimit(1)
                                .minimumScaleFactor(0.7)
                        }
                        let school = context.state.learnerSchool.trimmingCharacters(in: .whitespacesAndNewlines)
                        if !school.isEmpty {
                            Label(school, systemImage: "building.columns.fill")
                                .font(.caption2.weight(.medium))
                                .foregroundStyle(.secondary)
                                .labelStyle(.titleAndIcon)
                                .lineLimit(1)
                                .minimumScaleFactor(0.65)
                        }
                    }
                }
                DynamicIslandExpandedRegion(.trailing) {
                    VStack(alignment: .trailing, spacing: 3) {
                        Text(islandPhaseLabel(context.state.phase))
                            .font(.system(size: 9, weight: .bold))
                            .padding(.horizontal, 7)
                            .padding(.vertical, 2)
                            .background(Capsule().fill(Self.accent.opacity(0.35)))
                        Text("\(context.state.answered)/\(max(context.state.total, 1))")
                            .font(.title3.weight(.bold))
                            .monospacedDigit()
                            .minimumScaleFactor(0.85)
                    }
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(context.state.subtitleText)
                            .font(.caption.weight(.medium))
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                            .minimumScaleFactor(0.78)
                            .multilineTextAlignment(.leading)
                        HStack(spacing: 3) {
                            ForEach(0..<5, id: \.self) { i in
                                Capsule()
                                    .fill(i < context.state.segmentFilled ? Self.accent : Color.primary.opacity(0.15))
                                    .frame(height: 4)
                            }
                        }
                    }
                    .padding(.top, 2)
                }
            } compactLeading: {
                Image(systemName: "dot.radiowaves.left.and.right")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(Self.accent)
            } compactTrailing: {
                Text("\(context.state.answered)/\(max(context.state.total, 1))")
                    .font(.caption2.weight(.bold))
                    .monospacedDigit()
                    .minimumScaleFactor(0.75)
            } minimal: {
                Image(systemName: "chart.bar.fill")
                    .font(.caption2)
            }
        }
    }

    private func islandFullName(_ context: ActivityViewContext<RadstudyLiveSessionAttributes>) -> String {
        let f = context.state.learnerFirstName.trimmingCharacters(in: .whitespacesAndNewlines)
        let l = context.state.learnerLastName.trimmingCharacters(in: .whitespacesAndNewlines)
        let c = [f, l].filter { !$0.isEmpty }.joined(separator: " ")
        if !c.isEmpty { return c }
        let n = context.attributes.learnerName.trimmingCharacters(in: .whitespacesAndNewlines)
        return n.isEmpty ? "Learner" : n
    }

    private func islandLocationLine(_ context: ActivityViewContext<RadstudyLiveSessionAttributes>) -> String? {
        let p = context.state.learnerProvince.trimmingCharacters(in: .whitespacesAndNewlines)
        let c = context.state.learnerCountry.trimmingCharacters(in: .whitespacesAndNewlines)
        if !p.isEmpty && !c.isEmpty { return "\(p) · \(c)" }
        if !c.isEmpty { return c }
        if !p.isEmpty { return p }
        return nil
    }

    private func islandPhaseLabel(_ phase: String) -> String {
        switch phase {
        case "start": return "LIVE"
        case "progress": return "ACTIVE"
        case "complete": return "DONE"
        default: return "LIVE"
        }
    }
}
#endif
