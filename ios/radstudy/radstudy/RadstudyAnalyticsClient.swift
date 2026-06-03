import Foundation

/// Shared defaults for analytics / admin API calls.
enum RadstudyServerConfiguration {
    /// Production web and API origin: https://radiography-q300.onrender.com
    static let defaultProductionBaseURL = "https://radiography-q300.onrender.com"
}

enum RadstudyAnalyticsRequestError: LocalizedError {
    case transport(URLError)
    case invalidHTTPResponse
    case badHTTP(status: Int, snippet: String)
    case decoding(Error)

    var errorDescription: String? {
        switch self {
        case .transport(let u):
            switch u.code {
            case .cancelled:
                return "Request cancelled."
            case .cannotFindHost, .dnsLookupFailed:
                return "Could not find that host. Check the base URL in Control."
            case .cannotConnectToHost:
                return "Could not connect to the server. Nothing is accepting connections at that address."
            case .timedOut:
                return "The request timed out."
            case .notConnectedToInternet, .dataNotAllowed:
                return "No network connection."
            case .secureConnectionFailed:
                return "Secure connection failed: \(u.localizedDescription)"
            case .serverCertificateUntrusted:
                return "Certificate not trusted."
            default:
                return u.localizedDescription
            }
        case .invalidHTTPResponse:
            return "Invalid server response (not HTTP)."
        case .badHTTP(let status, let snippet):
            switch status {
            case 401:
                return "Sign-in required: the server did not accept this device as an admin (401)."
            case 403:
                return "Access denied: the server blocked this request (403)."
            default:
                let head = String(snippet.prefix(180))
                if status >= 500 { return "Server error (\(status))." }
                if head.isEmpty { return "Request failed (\(status))." }
                return "Request failed (\(status)): \(head)"
            }
        case .decoding:
            return "Could not read the server response (unexpected format)."
        }
    }

    var recoverySuggestion: String? {
        switch self {
        case .transport(let u):
            switch u.code {
            case .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed:
                return "The Simulator can use http://localhost:3110. On a physical iPhone, localhost is the phone itself—use your Mac’s LAN IP (e.g. http://192.168.1.12:3110) and ensure the API listens on 0.0.0.0. Production: use your real HTTPS base URL."
            case .secureConnectionFailed, .serverCertificateUntrusted:
                return "Use https:// with a valid certificate, or a trusted dev setup."
            default:
                return nil
            }
        case .badHTTP(let status, _):
            if status == 401 || status == 403 {
                return "Control → Trusted iPhone: paste the value that matches server env IOS_NATIVE_ADMIN_SECRET. Or set IOS_ALLOW_UNAUTH_ANALYTICS=true on the server. Or paste admin_uid=… from an admin browser session."
            }
            return nil
        case .invalidHTTPResponse:
            return "Check the base URL and that the Radstudy server is running."
        case .decoding:
            return "Try refreshing. If this keeps happening, the app may need an update for the current API."
        }
    }
}

private func responseSnippet(from data: Data, maxLen: Int = 220) -> String {
    let s = String(data: data, encoding: .utf8) ?? ""
    return String(s.prefix(maxLen)).trimmingCharacters(in: .whitespacesAndNewlines)
}

struct AdminAnalyticsSummaryResponse: Codable {
    let ok: Bool
    let generatedAt: String?
    let totalUsers: Int?
    let totalAdmins: Int?
    let totalTrials: Int?
    let loginCount: Int?
    let globalActiveDays: Int?
    let quizStarted: Int?
    let quizCompleted: Int?
    let simStarted: Int?
    let simCompleted: Int?
    let questionsAnswered: Int?
    let correctAnswers: Int?
    let incorrectAnswers: Int?
    let overallAccuracy: Int?
    let quizCompletionRate: Int?
    let simCompletionRate: Int?
    let totalSessions: Int?
    let completedSessions: Int?
    let avgSessionSeconds: Int?
    let totalStudySeconds: Int?
    let dailyLandingUsers: Int?
    let dailyTrialUsers: Int?
    let conversionLandingToTrialPercent: Int?
    let simExamCounts: [String: Int]?
}

struct UserSessionDTO: Codable {
    let _id: String?
    let mode: String?
    let examName: String?
    let durationSeconds: Int?
    let totalQuestions: Int?
    let questionsAnswered: Int?
    let correctAnswers: Int?
    let scorePercent: Int?
    let completed: Bool?
    let startedAt: String?
}

struct AdminAnalyticsUserResponse: Codable {
    struct UserInfo: Codable {
        let id: String
        let name: String
        let email: String
        let role: String
    }

    struct Summary: Codable {
        let sessions: Int
        let completedTests: Int
        let avgTestScore: Int
        let completedSimulations: Int
        let avgSimulationScore: Int
        let totalStudySeconds: Int
        let avgSessionSeconds: Int
    }

    let ok: Bool
    let user: UserInfo?
    let summary: Summary?
    let sessions: [UserSessionDTO]?
}

struct AdminOnlineUsersResponse: Codable {
    struct OnlineUser: Codable {
        let id: String
        let name: String
        let email: String
        let role: String
        let isEnabled: Bool
        let lastActive: String?
        let via: String
    }

    struct ActiveSession: Codable {
        let userId: String
        let userName: String
        let userEmail: String
        let role: String
        let mode: String
        let examName: String
        let lastSeenAt: String?
        let startedAt: String?
        let sessionId: String
        let questionsAnswered: Int?
        let totalQuestions: Int?
        let scorePercent: Int?
        let completed: Bool?
    }

    let ok: Bool
    let minutes: Int
    let generatedAt: String?
    let cutoff: String?
    let onlineUserCount: Int
    let activeSessionCount: Int?
    let onlineUsers: [OnlineUser]
    let activeSessions: [ActiveSession]?
}

struct AdminAnalyticsUsersListResponse: Codable {
    struct UserRow: Codable {
        let id: String
        let name: String
        let email: String
        let role: String
        let lastActive: String?
        let loginCount: Int
        let quizCompletedCount: Int
        let simulationCompletedCount: Int
    }

    let ok: Bool
    let generatedAt: String?
    let total: Int
    let users: [UserRow]
}

final class RadstudyAnalyticsClient {
    private let baseURL: URL
    private let session: URLSession
    private let decoder = JSONDecoder()

    init(baseURL: URL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    func fetchAdminSummary(cookieHeader: String? = nil) async throws -> AdminAnalyticsSummaryResponse {
        try await get(path: "/api/admin/analytics/summary", cookieHeader: cookieHeader)
    }

    func fetchUserAnalytics(userId: String, cookieHeader: String? = nil) async throws -> AdminAnalyticsUserResponse {
        try await get(path: "/api/admin/analytics/users/\(userId)", cookieHeader: cookieHeader)
    }

    func fetchOnlineUsers(minutes: Int = 4, cookieHeader: String? = nil) async throws -> AdminOnlineUsersResponse {
        let clamped = max(1, min(60, minutes))
        return try await get(path: "/api/admin/analytics/online-users?minutes=\(clamped)", cookieHeader: cookieHeader)
    }

    func fetchUsersList(cookieHeader: String? = nil) async throws -> AdminAnalyticsUsersListResponse {
        try await get(path: "/api/admin/analytics/users", cookieHeader: cookieHeader)
    }

    private func get<T: Decodable>(path: String, cookieHeader: String?) async throws -> T {
        let endpoint = URL(string: path, relativeTo: baseURL)!
        var request = URLRequest(url: endpoint)
        request.httpMethod = "GET"
        request.timeoutInterval = 25
        print("➡️ [Radstudy] GET \(endpoint.absoluteString)")
        print("🍪 [Radstudy] Cookie header set: \((cookieHeader?.isEmpty == false) ? "yes" : "no")")
        if let cookieHeader, !cookieHeader.isEmpty {
            request.setValue(cookieHeader, forHTTPHeaderField: "Cookie")
        }
        let native = UserDefaults.standard.string(forKey: "radstudy_ios_native_secret")?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "\n", with: "")
            .replacingOccurrences(of: "\r", with: "") ?? ""
        if !native.isEmpty {
            request.setValue(native, forHTTPHeaderField: "X-Radstudy-iOS-Secret")
        }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch let urlError as URLError {
            throw RadstudyAnalyticsRequestError.transport(urlError)
        } catch {
            throw error
        }
        if let http = response as? HTTPURLResponse {
            print("⬅️ [Radstudy] Status \(http.statusCode) for \(endpoint.path)")
        }
        print("📦 [Radstudy] Bytes \(data.count)")
        if let body = String(data: data, encoding: .utf8) {
            print("🧾 [Radstudy] Body preview: \(body.prefix(260))")
        }
        guard let http = response as? HTTPURLResponse else {
            throw RadstudyAnalyticsRequestError.invalidHTTPResponse
        }
        guard (200...299).contains(http.statusCode) else {
            let snippet = responseSnippet(from: data)
            print("❌ [Radstudy] Request failed status \(http.statusCode): \(snippet)")
            throw RadstudyAnalyticsRequestError.badHTTP(status: http.statusCode, snippet: snippet)
        }
        do {
            let decoded = try decoder.decode(T.self, from: data)
            print("✅ [Radstudy] Decode success for \(endpoint.path)")
            return decoded
        } catch {
            print("❌ [Radstudy] Decode error: \(error.localizedDescription)")
            throw RadstudyAnalyticsRequestError.decoding(error)
        }
    }
}
