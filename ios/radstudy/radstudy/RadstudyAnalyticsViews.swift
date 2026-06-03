import SwiftUI
import Combine
#if canImport(UIKit)
import UIKit
#endif

enum RadstudyTheme {
    static let maroon = Color(red: 104 / 255, green: 52 / 255, blue: 82 / 255)
    static let maroonDeep = Color(red: 58 / 255, green: 32 / 255, blue: 48 / 255)
    static let accentGold = Color(red: 243 / 255, green: 189 / 255, blue: 103 / 255)
    /// Teal-like accent for links / secondary actions (banking-app inspired).
    static let accentTeal = Color(red: 0 / 255, green: 132 / 255, blue: 138 / 255)
    /// Flat fallback (e.g. previews).
    static let bg = Color(red: 244 / 255, green: 245 / 255, blue: 248 / 255)

    /// Elevated surfaces (system grouped background adapts to light / dark).
    static var cardBackground: Color {
        #if os(iOS)
        Color(uiColor: .secondarySystemGroupedBackground)
        #else
        Color.white
        #endif
    }

    /// Page canvas — banking-style light grey sheet.
    static var sheetBackground: Color {
        #if os(iOS)
        Color(uiColor: .systemGroupedBackground)
        #else
        bg
        #endif
    }

    static var floatingTabBarFill: Color {
        #if os(iOS)
        Color(uiColor: .systemBackground)
        #else
        Color.white
        #endif
    }
}

private struct RadstudyScreenBackground: View {
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        Group {
            if colorScheme == .dark {
                LinearGradient(
                    colors: [
                        Color(red: 0.10, green: 0.10, blue: 0.12),
                        Color(red: 0.08, green: 0.08, blue: 0.10),
                        Color(red: 0.11, green: 0.09, blue: 0.12)
                    ],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )
            } else {
                RadstudyTheme.sheetBackground
            }
        }
    }
}

private extension View {
    /// Consistent canvas behind each tab’s navigation stack.
    func radstudyScreenBackground() -> some View {
        background(RadstudyScreenBackground().ignoresSafeArea())
    }

    func radstudyNavigationChrome() -> some View {
        toolbarBackground(.ultraThinMaterial, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .tint(RadstudyTheme.maroon)
    }
}

private func radstudyAnalyticsUserFacingError(_ error: Error) -> (message: String, tip: String?) {
    let le = error as? LocalizedError
    let message = le?.errorDescription ?? error.localizedDescription
    return (message, le?.recoverySuggestion)
}

private struct AnalyticsLoadErrorBanner: View {
    let message: String
    let tip: String

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.title2)
                .symbolRenderingMode(.hierarchical)
                .foregroundStyle(.orange)
            Text(message)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.primary)
                .multilineTextAlignment(.center)
            if !tip.isEmpty {
                Text(tip)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(RadstudyTheme.cardBackground)
                .shadow(color: .black.opacity(0.06), radius: 12, y: 4)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(Color.orange.opacity(0.35), lineWidth: 1)
        )
        .padding(.horizontal, 20)
    }
}

private func onlineWindowMinutes() -> Int {
    let v = UserDefaults.standard.integer(forKey: "radstudy_online_window_minutes")
    return v > 0 ? min(60, v) : 4
}

private struct RadstudyInlineLoading: View {
    var message: String = "Loading…"

    var body: some View {
        VStack(spacing: 16) {
            ProgressView()
                .controlSize(.large)
                .tint(RadstudyTheme.maroon)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.top, 24)
    }
}

// MARK: - Banking-inspired chrome (floating tab bar, section labels)

private enum AdminTab: Int, CaseIterable, Hashable {
    case dashboard, online, live, users, lookup, control

    var title: String {
        switch self {
        case .dashboard: "Dashboard"
        case .online: "Online"
        case .live: "Live"
        case .users: "Users"
        case .lookup: "Lookup"
        case .control: "Control"
        }
    }

    var symbol: String {
        switch self {
        case .dashboard: "chart.bar.fill"
        case .online: "person.2.fill"
        case .live: "circle.grid.3x3.fill"
        case .users: "person.text.rectangle"
        case .lookup: "magnifyingglass"
        case .control: "gearshape.fill"
        }
    }
}

private struct RadstudySectionHeader: View {
    let text: String

    var body: some View {
        Text(text.uppercased())
            .font(.caption.weight(.semibold))
            .tracking(0.85)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16)
    }
}

private struct RadstudyFloatingTabBar: View {
    @Binding var selection: AdminTab

    var body: some View {
        HStack(spacing: 2) {
            ForEach(AdminTab.allCases, id: \.self) { tab in
                Button {
                    selection = tab
                } label: {
                    VStack(spacing: 3) {
                        Image(systemName: tab.symbol)
                            .font(.system(size: 17, weight: .semibold))
                            .symbolVariant(selection == tab ? .fill : .none)
                        Text(tab.title)
                            .font(.caption2.weight(selection == tab ? .semibold : .regular))
                            .lineLimit(1)
                            .minimumScaleFactor(0.72)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 7)
                    .foregroundStyle(selection == tab ? RadstudyTheme.maroon : Color.primary.opacity(0.5))
                    .background(
                        Capsule()
                            .fill(selection == tab ? RadstudyTheme.maroon.opacity(0.14) : Color.clear)
                    )
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(tab.title)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 7)
        .background(
            Capsule()
                .fill(RadstudyTheme.floatingTabBarFill)
                .shadow(color: .black.opacity(0.14), radius: 18, y: 8)
                .overlay(
                    Capsule()
                        .strokeBorder(Color.primary.opacity(0.07), lineWidth: 1)
                )
        )
        .padding(.horizontal, 12)
        .padding(.bottom, 4)
    }
}

@MainActor
final class SummaryVM: ObservableObject {
    @Published var data: AdminAnalyticsSummaryResponse?
    @Published var loading = false
    @Published var error = ""
    @Published var errorTip = ""

    private let client: RadstudyAnalyticsClient
    private let cookieHeader: String?

    init(client: RadstudyAnalyticsClient, cookieHeader: String?) {
        self.client = client
        self.cookieHeader = cookieHeader
    }

    func load() async {
        loading = true
        error = ""
        errorTip = ""
        do {
            data = try await client.fetchAdminSummary(cookieHeader: cookieHeader)
        } catch {
            let pair = radstudyAnalyticsUserFacingError(error)
            self.error = pair.message
            self.errorTip = pair.tip ?? ""
        }
        loading = false
    }
}

@MainActor
final class OnlineVM: ObservableObject {
    @Published var data: AdminOnlineUsersResponse?
    @Published var loading = false
    @Published var error = ""
    @Published var errorTip = ""
    private let client: RadstudyAnalyticsClient
    private let cookieHeader: String?

    init(client: RadstudyAnalyticsClient, cookieHeader: String?) {
        self.client = client
        self.cookieHeader = cookieHeader
    }

    func load() async {
        loading = true
        error = ""
        errorTip = ""
        do {
            data = try await client.fetchOnlineUsers(minutes: onlineWindowMinutes(), cookieHeader: cookieHeader)
        } catch {
            let pair = radstudyAnalyticsUserFacingError(error)
            self.error = pair.message
            self.errorTip = pair.tip ?? ""
        }
        loading = false
    }
}

@MainActor
final class UserDetailVM: ObservableObject {
    @Published var data: AdminAnalyticsUserResponse?
    @Published var loading = false
    @Published var error = ""
    @Published var errorTip = ""
    private let client: RadstudyAnalyticsClient
    private let cookieHeader: String?

    init(client: RadstudyAnalyticsClient, cookieHeader: String?) {
        self.client = client
        self.cookieHeader = cookieHeader
    }

    func load(userId: String) async {
        loading = true
        error = ""
        errorTip = ""
        do {
            data = try await client.fetchUserAnalytics(userId: userId, cookieHeader: cookieHeader)
        } catch {
            let pair = radstudyAnalyticsUserFacingError(error)
            self.error = pair.message
            self.errorTip = pair.tip ?? ""
        }
        loading = false
    }
}

@MainActor
final class UsersListVM: ObservableObject {
    @Published var data: AdminAnalyticsUsersListResponse?
    @Published var loading = false
    @Published var error = ""
    @Published var errorTip = ""
    private let client: RadstudyAnalyticsClient
    private let cookieHeader: String?

    init(client: RadstudyAnalyticsClient, cookieHeader: String?) {
        self.client = client
        self.cookieHeader = cookieHeader
    }

    func load() async {
        loading = true
        error = ""
        errorTip = ""
        do {
            data = try await client.fetchUsersList(cookieHeader: cookieHeader)
        } catch {
            do {
                let online = try await client.fetchOnlineUsers(minutes: 60, cookieHeader: cookieHeader)
                let rows = (online.onlineUsers).map { u in
                    AdminAnalyticsUsersListResponse.UserRow(
                        id: u.id,
                        name: u.name,
                        email: u.email,
                        role: u.role,
                        lastActive: u.lastActive,
                        loginCount: 0,
                        quizCompletedCount: 0,
                        simulationCompletedCount: 0
                    )
                }
                data = AdminAnalyticsUsersListResponse(
                    ok: true,
                    generatedAt: online.generatedAt,
                    total: rows.count,
                    users: rows
                )
            } catch {
                let pair = radstudyAnalyticsUserFacingError(error)
                self.error = pair.message
                self.errorTip = pair.tip ?? ""
            }
        }
        loading = false
    }
}

// MARK: - Dashboard

struct AnalyticsHomeView: View {
    @StateObject private var vm: SummaryVM
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    init(baseURL: URL, cookieHeader: String?) {
        _vm = StateObject(wrappedValue: SummaryVM(client: RadstudyAnalyticsClient(baseURL: baseURL), cookieHeader: cookieHeader))
    }

    private var dashboardColumns: [GridItem] {
        let minW: CGFloat = horizontalSizeClass == .compact ? 148 : 128
        return [GridItem(.adaptive(minimum: minW), spacing: 10)]
    }

    var body: some View {
        NavigationStack {
            ZStack {
                if vm.loading {
                    RadstudyInlineLoading(message: "Loading analytics…")
                } else if !vm.error.isEmpty {
                    AnalyticsLoadErrorBanner(message: vm.error, tip: vm.errorTip)
                } else {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 12) {
                            if let at = vm.data?.generatedAt, !at.isEmpty {
                                Text("Updated \(at)")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .frame(maxWidth: .infinity, alignment: .trailing)
                                    .padding(.horizontal, 4)
                            }
                            RadstudySectionHeader(text: "Overview metrics")
                            LazyVGrid(columns: dashboardColumns, spacing: 12) {
                            metric("Total users", "\(vm.data?.totalUsers ?? 0)")
                            metric("Admins", "\(vm.data?.totalAdmins ?? 0)")
                            metric("Trial accounts", "\(vm.data?.totalTrials ?? 0)")
                            metric("Logins (all time)", "\(vm.data?.loginCount ?? 0)")
                            metric("Active day keys", "\(vm.data?.globalActiveDays ?? 0)")
                            metric("Quiz started", "\(vm.data?.quizStarted ?? 0)")
                            metric("Quiz completed", "\(vm.data?.quizCompleted ?? 0)")
                            metric("Quiz completion %", "\(vm.data?.quizCompletionRate ?? 0)%")
                            metric("Sim started", "\(vm.data?.simStarted ?? 0)")
                            metric("Sim completed", "\(vm.data?.simCompleted ?? 0)")
                            metric("Sim completion %", "\(vm.data?.simCompletionRate ?? 0)%")
                            metric("Questions answered", "\(vm.data?.questionsAnswered ?? 0)")
                            metric("Correct", "\(vm.data?.correctAnswers ?? 0)")
                            metric("Incorrect", "\(vm.data?.incorrectAnswers ?? 0)")
                            metric("Overall accuracy", "\(vm.data?.overallAccuracy ?? 0)%")
                            metric("Sessions (rows)", "\(vm.data?.totalSessions ?? 0)")
                            metric("Sessions completed", "\(vm.data?.completedSessions ?? 0)")
                            metric("Avg session (s)", "\(vm.data?.avgSessionSeconds ?? 0)")
                            metric("Study seconds (sum)", formatSeconds(vm.data?.totalStudySeconds))
                            metric("Landing today", "\(vm.data?.dailyLandingUsers ?? 0)")
                            metric("Trial today", "\(vm.data?.dailyTrialUsers ?? 0)")
                            metric("Landing→trial %", "\(vm.data?.conversionLandingToTrialPercent ?? 0)%")
                            }
                            .padding(.horizontal, 16)
                            .padding(.vertical, 4)
                        }
                    }
                }
            }
            .navigationTitle("Analytics")
            .navigationBarTitleDisplayMode(.large)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Task { await vm.load() }
                    } label: {
                        Label("Refresh", systemImage: "arrow.clockwise")
                    }
                    .accessibilityLabel("Refresh analytics")
                }
            }
            .radstudyNavigationChrome()
            .task { await vm.load() }
        }
        .radstudyScreenBackground()
    }

    private func formatSeconds(_ s: Int?) -> String {
        guard let s, s > 0 else { return "0" }
        if s >= 3600 { return String(format: "%.1fh", Double(s) / 3600) }
        return "\(s / 60)m"
    }

    private func metric(_ title: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(2)
                .minimumScaleFactor(0.85)
            Text(value)
                .font(.title3.weight(.semibold))
                .foregroundStyle(.primary)
                .minimumScaleFactor(0.7)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(RadstudyTheme.cardBackground)
                .shadow(color: .black.opacity(0.08), radius: 12, y: 4)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(RadstudyTheme.maroon.opacity(0.06), lineWidth: 1)
        )
    }
}

// MARK: - Online users

struct OnlineUsersView: View {
    @StateObject private var vm: OnlineVM
    let baseURL: URL
    let cookieHeader: String?
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    init(baseURL: URL, cookieHeader: String?) {
        self.baseURL = baseURL
        self.cookieHeader = cookieHeader
        _vm = StateObject(wrappedValue: OnlineVM(client: RadstudyAnalyticsClient(baseURL: baseURL), cookieHeader: cookieHeader))
    }

    private var userColumns: [GridItem] {
        if horizontalSizeClass == .compact { return [GridItem(.flexible())] }
        return [GridItem(.adaptive(minimum: 280), spacing: 12)]
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                if vm.loading {
                    RadstudyInlineLoading(message: "Loading online users…")
                } else if !vm.error.isEmpty {
                    AnalyticsLoadErrorBanner(message: vm.error, tip: vm.errorTip)
                } else {
                    VStack(alignment: .leading, spacing: 20) {
                        RadstudySectionHeader(text: "Snapshot")
                        HStack(spacing: 8) {
                            statChip("Online", "\(vm.data?.onlineUserCount ?? 0)")
                            statChip("Sessions", "\(vm.data?.activeSessionCount ?? 0)")
                            statChip("Window", "\(vm.data?.minutes ?? onlineWindowMinutes())m")
                            Spacer(minLength: 0)
                        }
                        .padding(.horizontal, 16)

                        RadstudySectionHeader(text: "Online users")
                        LazyVGrid(columns: userColumns, spacing: 10) {
                            ForEach(vm.data?.onlineUsers ?? [], id: \.id) { user in
                                NavigationLink {
                                    UserAnalyticsDetailView(baseURL: baseURL, cookieHeader: cookieHeader, userId: user.id)
                                } label: {
                                    userTile(user)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        .padding(.horizontal, 16)
                    }
                    .padding(.vertical, 12)
                }
            }
            .navigationTitle("Online")
            .navigationBarTitleDisplayMode(.large)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Task { await vm.load() }
                    } label: {
                        Label("Refresh", systemImage: "arrow.clockwise")
                    }
                }
            }
            .radstudyNavigationChrome()
            .task { await vm.load() }
        }
        .radstudyScreenBackground()
    }

    private func statChip(_ title: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.caption2).foregroundStyle(.secondary)
            Text(value).font(.title3.weight(.semibold))
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(RadstudyTheme.cardBackground)
                .shadow(color: .black.opacity(0.05), radius: 6, y: 2)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(RadstudyTheme.maroon.opacity(0.12), lineWidth: 1)
        )
    }

    private func userTile(_ user: AdminOnlineUsersResponse.OnlineUser) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(user.name.isEmpty ? user.email : user.name)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.primary)
            Text("\(user.role) · \(user.via)")
                .font(.caption)
                .foregroundStyle(.secondary)
            if let last = user.lastActive, !last.isEmpty {
                Text(last)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .lineLimit(2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(RadstudyTheme.cardBackground)
                .shadow(color: .black.opacity(0.08), radius: 12, y: 4)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(RadstudyTheme.maroon.opacity(0.1), lineWidth: 1)
        )
    }
}

// MARK: - User detail

struct UserAnalyticsDetailView: View {
    @StateObject private var vm: UserDetailVM
    let userId: String

    init(baseURL: URL, cookieHeader: String?, userId: String) {
        self.userId = userId
        _vm = StateObject(wrappedValue: UserDetailVM(client: RadstudyAnalyticsClient(baseURL: baseURL), cookieHeader: cookieHeader))
    }

    private let detailColumns = [GridItem(.adaptive(minimum: 140), spacing: 8)]

    var body: some View {
        List {
            if !vm.error.isEmpty {
                Section {
                    Text(vm.error).foregroundStyle(.red)
                    if !vm.errorTip.isEmpty {
                        Text(vm.errorTip).font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            if let user = vm.data?.user {
                Section("User") {
                    Text(user.name).font(.headline)
                    Text(user.email).font(.caption).foregroundStyle(.secondary)
                    Text(user.role).font(.caption).foregroundStyle(.secondary)
                }
            }
            if let summary = vm.data?.summary {
                Section("Summary") {
                    LazyVGrid(columns: detailColumns, spacing: 8) {
                        miniMetric("Sessions", "\(summary.sessions)")
                        miniMetric("Completed tests", "\(summary.completedTests)")
                        miniMetric("Avg test score", "\(summary.avgTestScore)%")
                        miniMetric("Completed sims", "\(summary.completedSimulations)")
                        miniMetric("Avg sim score", "\(summary.avgSimulationScore)%")
                        miniMetric("Avg session (s)", "\(summary.avgSessionSeconds)")
                        miniMetric("Study time", formatStudy(summary.totalStudySeconds))
                    }
                    .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                }
            }
            Section("Sessions") {
                ForEach(Array((vm.data?.sessions ?? []).enumerated()), id: \.offset) { _, s in
                    VStack(alignment: .leading, spacing: 4) {
                        Text((s.mode ?? "unknown").capitalized)
                            .font(.subheadline.weight(.medium))
                        Text("Score \(s.scorePercent ?? 0)% · Answered \(s.questionsAnswered ?? 0)/\(s.totalQuestions ?? 0)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        if s.completed == true {
                            Text("Completed").font(.caption2.weight(.semibold)).foregroundStyle(.green)
                        }
                    }
                    .padding(.vertical, 4)
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .navigationTitle("User")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    Task { await vm.load(userId: userId) }
                } label: {
                    Label("Refresh", systemImage: "arrow.clockwise")
                }
            }
        }
        .radstudyNavigationChrome()
        .task { await vm.load(userId: userId) }
        .radstudyScreenBackground()
    }

    private func miniMetric(_ t: String, _ v: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(t).font(.caption2).foregroundStyle(.secondary)
            Text(v).font(.caption.weight(.semibold))
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(RadstudyTheme.cardBackground))
    }

    private func formatStudy(_ sec: Int) -> String {
        guard sec > 0 else { return "0" }
        if sec >= 3600 { return String(format: "%.1fh", Double(sec) / 3600) }
        return "\(sec / 60)m"
    }
}

struct UserLookupView: View {
    let baseURL: URL
    let cookieHeader: String?
    @State private var userId = ""
    @State private var open = false

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 20) {
                Text("Enter a user’s Mongo id to open their analytics.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                TextField("User id", text: $userId)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .padding(14)
                    .background(RadstudyTheme.cardBackground, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .strokeBorder(Color.primary.opacity(0.08), lineWidth: 1)
                    )
                Button {
                    open = !userId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                } label: {
                    Text("Open user analytics")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(RadstudyTheme.maroon)
                .controlSize(.large)
                .disabled(userId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                Spacer(minLength: 0)
            }
            .padding(20)
            .navigationTitle("Lookup")
            .navigationBarTitleDisplayMode(.large)
            .radstudyNavigationChrome()
            .navigationDestination(isPresented: $open) {
                UserAnalyticsDetailView(
                    baseURL: baseURL,
                    cookieHeader: cookieHeader,
                    userId: userId.trimmingCharacters(in: .whitespacesAndNewlines)
                )
            }
        }
        .radstudyScreenBackground()
    }
}

// MARK: - Users list

struct UsersListView: View {
    @StateObject private var vm: UsersListVM
    let baseURL: URL
    let cookieHeader: String?
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    init(baseURL: URL, cookieHeader: String?) {
        self.baseURL = baseURL
        self.cookieHeader = cookieHeader
        _vm = StateObject(wrappedValue: UsersListVM(client: RadstudyAnalyticsClient(baseURL: baseURL), cookieHeader: cookieHeader))
    }

    private var cols: [GridItem] {
        if horizontalSizeClass == .compact { return [GridItem(.flexible())] }
        return [GridItem(.adaptive(minimum: 300), spacing: 12)]
    }

    var body: some View {
        NavigationStack {
            Group {
                if vm.loading {
                    RadstudyInlineLoading(message: "Loading users…")
                } else if !vm.error.isEmpty {
                    AnalyticsLoadErrorBanner(message: vm.error, tip: vm.errorTip)
                } else {
                    ScrollView {
                        RadstudySectionHeader(text: "All users")
                            .padding(.horizontal, 16)
                            .padding(.top, 4)
                        LazyVGrid(columns: cols, spacing: 12) {
                            ForEach(vm.data?.users ?? [], id: \.id) { user in
                                NavigationLink {
                                    UserAnalyticsDetailView(baseURL: baseURL, cookieHeader: cookieHeader, userId: user.id)
                                } label: {
                                    VStack(alignment: .leading, spacing: 8) {
                                        Text(user.name.isEmpty ? user.email : user.name)
                                            .font(.headline)
                                            .foregroundStyle(.primary)
                                        Text("\(user.role) · \(user.email)")
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                            .lineLimit(2)
                                        Text("Logins \(user.loginCount) · Tests \(user.quizCompletedCount) · Sims \(user.simulationCompletedCount)")
                                            .font(.caption2)
                                            .foregroundStyle(.tertiary)
                                    }
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(14)
                                    .background(
                                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                                            .fill(RadstudyTheme.cardBackground)
                                            .shadow(color: .black.opacity(0.08), radius: 12, y: 4)
                                    )
                                    .overlay(
                                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                                            .strokeBorder(RadstudyTheme.maroon.opacity(0.08), lineWidth: 1)
                                    )
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        .padding(.horizontal, 16)
                        .padding(.vertical, 12)
                    }
                }
            }
            .navigationTitle("Users")
            .navigationBarTitleDisplayMode(.large)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Task { await vm.load() }
                    } label: {
                        Label("Refresh", systemImage: "arrow.clockwise")
                    }
                }
            }
            .radstudyNavigationChrome()
            .task { await vm.load() }
        }
        .radstudyScreenBackground()
    }
}

// MARK: - Live session card (grid)

private struct LiveSessionCard: View {
    let session: AdminOnlineUsersResponse.ActiveSession

    private var progress: Double {
        let t = max(session.totalQuestions ?? 0, 0)
        let a = max(session.questionsAnswered ?? 0, 0)
        guard t > 0 else { return 0 }
        return min(1, Double(a) / Double(t))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Circle()
                    .fill(Color.green.opacity(0.85))
                    .frame(width: 9, height: 9)
                    .overlay(Circle().stroke(Color.green.opacity(0.35), lineWidth: 3).scaleEffect(1.6))
                Spacer()
                Text(session.mode.capitalized)
                    .font(.caption2.weight(.bold))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(Capsule().fill(Color.white.opacity(0.18)))
            }
            Text(session.userName.isEmpty ? session.userEmail : session.userName)
                .font(.headline)
                .foregroundStyle(.white)
                .lineLimit(2)
            Text("\(session.role)")
                .font(.caption)
                .foregroundStyle(.white.opacity(0.85))
            if !session.examName.isEmpty {
                Text(session.examName)
                    .font(.caption)
                    .foregroundStyle(RadstudyTheme.accentGold)
                    .lineLimit(2)
            }
            if (session.totalQuestions ?? 0) > 0 {
                ProgressView(value: progress)
                    .tint(RadstudyTheme.accentGold)
                HStack {
                    Text("\(session.questionsAnswered ?? 0)/\(session.totalQuestions ?? 0) Q")
                        .font(.caption2)
                    if (session.scorePercent ?? 0) > 0 {
                        Text("· \(session.scorePercent ?? 0)%")
                            .font(.caption2)
                    }
                    if session.completed == true {
                        Text("· Done")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.green.opacity(0.9))
                    }
                }
                .foregroundStyle(.white.opacity(0.9))
            }
            if let last = session.lastSeenAt, !last.isEmpty {
                Text("Seen \(last)")
                    .font(.caption2)
                    .foregroundStyle(.white.opacity(0.75))
                    .lineLimit(2)
            }
            Text("Session \(String(session.sessionId.prefix(10)))…")
                .font(.caption2)
                .foregroundStyle(.white.opacity(0.55))
                .textSelection(.enabled)
        }
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 16)
                .fill(
                    LinearGradient(
                        colors: [RadstudyTheme.maroon, RadstudyTheme.maroonDeep],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 16)
                        .stroke(RadstudyTheme.accentGold.opacity(0.35), lineWidth: 1)
                )
        )
    }
}

/// Completed (or fully answered) live cards can be swiped right to hide locally until the next full refresh.
private struct LiveSessionCardDismissible: View {
    let session: AdminOnlineUsersResponse.ActiveSession
    let onDismissed: () -> Void

    @State private var dragX: CGFloat = 0

    private var isDone: Bool {
        if session.completed == true { return true }
        let t = max(session.totalQuestions ?? 0, 0)
        let a = max(session.questionsAnswered ?? 0, 0)
        return t > 0 && a >= t
    }

    var body: some View {
        let card = LiveSessionCard(session: session)
            .offset(x: dragX)
            .animation(.interactiveSpring(response: 0.22, dampingFraction: 0.88), value: dragX)

        Group {
            if isDone {
                card
                    .highPriorityGesture(dismissDrag)
            } else {
                card
            }
        }
    }

    private var dismissDrag: some Gesture {
        DragGesture(minimumDistance: 16)
            .onChanged { value in
                let w = value.translation.width
                let h = abs(value.translation.height)
                guard w > 0, w > h * 0.55 else { return }
                dragX = min(max(0, w), 360)
            }
            .onEnded { value in
                let w = value.translation.width
                let predicted = value.predictedEndTranslation.width
                let shouldDismiss = w > 80 || predicted > 120
                if shouldDismiss {
                    withAnimation(.spring(response: 0.38, dampingFraction: 0.9)) {
                        dragX = 560
                    }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.28) {
                        onDismissed()
                    }
                } else {
                    withAnimation(.spring(response: 0.34, dampingFraction: 0.84)) {
                        dragX = 0
                    }
                }
            }
    }
}

// MARK: - Live sessions (grid + auto refresh)

struct LiveSessionsView: View {
    @StateObject private var vm: OnlineVM
    @State private var knownSessionIds: Set<String> = []
    @State private var newlyActiveSessions: [AdminOnlineUsersResponse.ActiveSession] = []
    @State private var flashNewSection = false
    @State private var lastRefresh = Date()
    /// Session ids the user swiped away (completed rows only); cleared on toolbar refresh.
    @State private var dismissedLiveSessionIds: Set<String> = []
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @AppStorage("radstudy_live_poll_seconds") private var livePollSeconds = 8

    private var pollEvery: TimeInterval {
        TimeInterval(min(120, max(5, livePollSeconds)))
    }

    private var gridColumns: [GridItem] {
        [GridItem(.adaptive(minimum: horizontalSizeClass == .compact ? 300 : 280), spacing: 12)]
    }

    init(baseURL: URL, cookieHeader: String?) {
        _vm = StateObject(wrappedValue: OnlineVM(client: RadstudyAnalyticsClient(baseURL: baseURL), cookieHeader: cookieHeader))
    }

    private var allActiveSessions: [AdminOnlineUsersResponse.ActiveSession] {
        vm.data?.activeSessions ?? []
    }

    private var visibleActiveSessions: [AdminOnlineUsersResponse.ActiveSession] {
        allActiveSessions.filter { !dismissedLiveSessionIds.contains($0.sessionId) }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                liveSessionsScrollContent
            }
            .navigationTitle("Live")
            .navigationBarTitleDisplayMode(.large)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Task {
                            dismissedLiveSessionIds.removeAll()
                            await refreshAndTrackNewSessions()
                        }
                    } label: {
                        Label("Refresh", systemImage: "arrow.clockwise")
                    }
                }
            }
            .radstudyNavigationChrome()
            .refreshable {
                dismissedLiveSessionIds.removeAll()
                await refreshAndTrackNewSessions()
            }
            .task { await refreshAndTrackNewSessions() }
        }
        .id("live-poll-\(livePollSeconds)")
        .onReceive(Timer.publish(every: pollEvery, on: .main, in: .common).autoconnect()) { _ in
            Task { await refreshAndTrackNewSessions() }
        }
        .onChange(of: newlyActiveSessions.count) { _, newCount in
            if newCount > 0 {
                withAnimation(.easeInOut(duration: 0.75).repeatCount(6, autoreverses: true)) {
                    flashNewSection.toggle()
                }
            } else {
                flashNewSection = false
            }
        }
        .radstudyScreenBackground()
    }

    @ViewBuilder
    private var liveSessionsScrollContent: some View {
        if vm.loading && vm.data == nil {
            RadstudyInlineLoading(message: "Loading live sessions…")
        } else if !vm.error.isEmpty {
            AnalyticsLoadErrorBanner(message: vm.error, tip: vm.errorTip)
        } else {
            liveSessionsLoadedColumn
        }
    }

    private var liveSessionsLoadedColumn: some View {
        VStack(alignment: .leading, spacing: 20) {
            RadstudySectionHeader(text: "Live overview")
            liveStatPillsRow
            liveNewThisCycleSection
            liveGridSectionHeader
            liveGridSectionBody
            Text("Last refresh: \(lastRefresh.formatted(date: .omitted, time: .shortened))")
                .font(.caption)
                .foregroundStyle(.tertiary)
                .padding(.horizontal, 16)
                .padding(.bottom, 12)
        }
        .padding(.top, 12)
    }

    private var liveStatPillsRow: some View {
        HStack(spacing: 8) {
            statPill("Online", "\(vm.data?.onlineUserCount ?? 0)")
            statPill("Live sessions", "\(vm.data?.activeSessionCount ?? 0)")
            statPill("Poll", "\(Int(pollEvery))s")
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16)
    }

    @ViewBuilder
    private var liveNewThisCycleSection: some View {
        if !newlyActiveSessions.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                Text("New this cycle")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                ForEach(newlyActiveSessions, id: \.sessionId) { s in
                    Text(s.userName.isEmpty ? s.userEmail : s.userName)
                        .font(.subheadline.weight(.medium))
                        .padding(12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(
                            RoundedRectangle(cornerRadius: 12, style: .continuous)
                                .fill(RadstudyTheme.accentGold.opacity(flashNewSection ? 0.28 : 0.16))
                        )
                        .overlay(
                            RoundedRectangle(cornerRadius: 12, style: .continuous)
                                .strokeBorder(RadstudyTheme.maroon.opacity(0.2), lineWidth: 1)
                        )
                }
            }
            .padding(.horizontal, 16)
        }
    }

    private var liveGridSectionHeader: some View {
        VStack(alignment: .leading, spacing: 8) {
            RadstudySectionHeader(text: "Active sessions")
            Text("Done sessions: swipe right to remove from this list.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 16)
        }
    }

    @ViewBuilder
    private var liveGridSectionBody: some View {
        if visibleActiveSessions.isEmpty {
            Text(
                allActiveSessions.isEmpty
                    ? "No active sessions in the last window."
                    : "No sessions shown — pull to refresh or tap Refresh to restore dismissed cards."
            )
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 24)
            .padding(.horizontal, 16)
        } else {
            LazyVGrid(columns: gridColumns, spacing: 12) {
                ForEach(visibleActiveSessions, id: \.sessionId) { s in
                    LiveSessionCardDismissible(session: s) {
                        withAnimation(.easeInOut(duration: 0.25)) {
                            _ = dismissedLiveSessionIds.insert(s.sessionId)
                        }
                    }
                }
            }
            .padding(.horizontal, 16)
        }
    }

    private func statPill(_ title: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.caption2).foregroundStyle(.secondary)
            Text(value).font(.title3.weight(.semibold))
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(RadstudyTheme.cardBackground)
                .shadow(color: .black.opacity(0.05), radius: 6, y: 2)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(RadstudyTheme.maroon.opacity(0.12), lineWidth: 1)
        )
    }

    @MainActor
    private func refreshAndTrackNewSessions() async {
        await vm.load()
        lastRefresh = Date()
        let currentSessions = vm.data?.activeSessions ?? []
        let currentIds = Set(currentSessions.map { $0.sessionId })
        dismissedLiveSessionIds = dismissedLiveSessionIds.intersection(currentIds)

        if knownSessionIds.isEmpty {
            knownSessionIds = currentIds
            newlyActiveSessions = []
            return
        }

        let newIds = currentIds.subtracting(knownSessionIds)
        newlyActiveSessions = currentSessions.filter { newIds.contains($0.sessionId) }
        knownSessionIds = currentIds
    }
}

// MARK: - Control (server, cookie, web admin)

struct ControlCenterView: View {
    @AppStorage("radstudy_base_url") private var baseURLString = RadstudyServerConfiguration.defaultProductionBaseURL
    @AppStorage("radstudy_admin_cookie") private var adminCookie = ""
    @AppStorage("radstudy_push_admin_email") private var pushAdminEmail = ""
    @AppStorage("radstudy_ios_native_secret") private var iosNativeSecret = ""
    @AppStorage("radstudy_live_poll_seconds") private var pollSeconds = 8
    @AppStorage("radstudy_online_window_minutes") private var onlineMinutes = 4

    var body: some View {
        NavigationStack {
            Form {
                Section("Server") {
                    TextField("Base URL (no trailing slash)", text: $baseURLString)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .keyboardType(.URL)
                        #endif
                    Text("Simulator: localhost is fine. On a real device, use your Mac’s LAN IP (System Settings → Network), not localhost, unless you use a tunnel.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    HStack {
                        Button("Local :3110") {
                            baseURLString = "http://localhost:3110"
                        }
                        Button("Render") {
                            baseURLString = RadstudyServerConfiguration.defaultProductionBaseURL
                        }
                    }
                    .font(.caption)
                }
                Section("Push (admin device)") {
                    Text("Optional. If set, token registration tells the server to attach this device to that admin email. Leave empty to use the first enabled admin account.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    TextField("Admin email (optional)", text: $pushAdminEmail)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .keyboardType(.emailAddress)
                        #endif
                }
                #if canImport(ActivityKit) && canImport(UIKit)
                Section("Live Activity (test)") {
                    Text("Lock screen Live Activities only start when this app receives a live_session push, or when you use the button below. Starting a quiz in the web app does not talk to this iPhone unless this device is registered as an admin push target.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Button("Start sample Live Activity") {
                        Task { @MainActor in
                            await RadstudyLiveSessionActivityManager.startSampleLiveActivityForTesting()
                        }
                    }
                }
                #endif
                Section("Trusted iPhone (recommended)") {
                    Text("If the server has IOS_NATIVE_ADMIN_SECRET set, paste the same value here once. The app sends it as header X-Radstudy-iOS-Secret so analytics work without cookies. Push registration uses it too.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    SecureField("Native admin secret (optional)", text: $iosNativeSecret)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Button("Clear native secret") {
                        iosNativeSecret = ""
                    }
                    .foregroundStyle(.red)
                }
                Section("Authentication (cookie)") {
                    Text("Optional if you use Trusted iPhone or the server flag IOS_ALLOW_UNAUTH_ANALYTICS. Otherwise: admin_uid=value from Chrome Application → Cookies after admin login.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    TextField("admin_uid=…", text: $adminCookie, axis: .vertical)
                        .lineLimit(3...6)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Button("Clear cookie") {
                        adminCookie = ""
                    }
                    .foregroundStyle(.red)
                }
                Section("Live & online data") {
                    Stepper("Auto-refresh every \(pollSeconds) seconds", value: $pollSeconds, in: 5...120, step: 1)
                    Stepper("Online window: \(onlineMinutes) minutes", value: $onlineMinutes, in: 1...60, step: 1)
                }
                Section("Web admin (opens in Safari)") {
                    adminLink("Admin login", "/admin/login")
                    adminLink("Dashboard", "/admin/dashboard")
                    adminLink("Analytics", "/admin/analytics")
                    adminLink("Online users", "/admin/analytics/online-users")
                    adminLink("Live exams", "/admin/analytics/live-exams")
                    adminLink("Live login sessions", "/admin/analytics/live-login-sessions")
                }
                Section("About") {
                    Text("Server: set IOS_ALLOW_UNAUTH_ANALYTICS=true to allow analytics without cookie or secret (wide open—Render only if you accept risk). Prefer IOS_NATIVE_ADMIN_SECRET on the server and the same value under Trusted iPhone here. After changing URL, secret, or cookie, switch tabs or pull to refresh.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .formStyle(.grouped)
            .scrollContentBackground(.hidden)
            .navigationTitle("Control")
            .navigationBarTitleDisplayMode(.large)
            .radstudyNavigationChrome()
        }
        .radstudyScreenBackground()
    }

    private var resolvedRoot: String {
        baseURLString.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }

    @ViewBuilder
    private func adminLink(_ title: String, _ path: String) -> some View {
        let p = path.hasPrefix("/") ? path : "/\(path)"
        if let u = URL(string: "\(resolvedRoot)\(p)") {
            Link(title, destination: u)
                .tint(RadstudyTheme.accentTeal)
        } else {
            Text(title).foregroundStyle(.secondary)
        }
    }
}

// MARK: - Root

struct AdminAnalyticsRootView: View {
    let baseURL: URL
    let cookieHeader: String?

    @State private var tab: AdminTab = .dashboard

    var body: some View {
        Group {
            switch tab {
            case .dashboard:
                AnalyticsHomeView(baseURL: baseURL, cookieHeader: cookieHeader)
            case .online:
                OnlineUsersView(baseURL: baseURL, cookieHeader: cookieHeader)
            case .live:
                LiveSessionsView(baseURL: baseURL, cookieHeader: cookieHeader)
            case .users:
                UsersListView(baseURL: baseURL, cookieHeader: cookieHeader)
            case .lookup:
                UserLookupView(baseURL: baseURL, cookieHeader: cookieHeader)
            case .control:
                ControlCenterView()
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            RadstudyFloatingTabBar(selection: $tab)
        }
        .tint(RadstudyTheme.maroon)
    }
}
