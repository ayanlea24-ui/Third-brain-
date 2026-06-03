#if canImport(ActivityKit)
import ActivityKit

/// Live Activity attributes for admin “live session” monitoring. Keep in sync with
/// `LiveSessionWidget/RadstudyLiveSessionAttributes.swift` (same fields / layout).
struct RadstudyLiveSessionAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable, Sendable {
        public var phase: String
        public var titleText: String
        public var subtitleText: String
        public var answered: Int
        public var total: Int
        /// 0…5 filled segments (Uber-style bar).
        public var segmentFilled: Int
        public var endedScorePercent: Int?
        public var learnerFirstName: String
        public var learnerLastName: String
        public var learnerCountry: String
        public var learnerProvince: String
        public var learnerSchool: String

        public init(
            phase: String,
            titleText: String,
            subtitleText: String,
            answered: Int,
            total: Int,
            segmentFilled: Int,
            endedScorePercent: Int? = nil,
            learnerFirstName: String = "",
            learnerLastName: String = "",
            learnerCountry: String = "",
            learnerProvince: String = "",
            learnerSchool: String = ""
        ) {
            self.phase = phase
            self.titleText = titleText
            self.subtitleText = subtitleText
            self.answered = answered
            self.total = total
            self.segmentFilled = segmentFilled
            self.endedScorePercent = endedScorePercent
            self.learnerFirstName = learnerFirstName
            self.learnerLastName = learnerLastName
            self.learnerCountry = learnerCountry
            self.learnerProvince = learnerProvince
            self.learnerSchool = learnerSchool
        }
    }

    public var sessionId: String
    public var learnerName: String

    public init(sessionId: String, learnerName: String) {
        self.sessionId = sessionId
        self.learnerName = learnerName
    }
}
#endif
