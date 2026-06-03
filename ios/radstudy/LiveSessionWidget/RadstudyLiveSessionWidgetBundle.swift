#if canImport(WidgetKit) && canImport(SwiftUI)
import SwiftUI
import WidgetKit

@main
struct RadstudyLiveSessionWidgetBundle: WidgetBundle {
    var body: some Widget {
        RadstudyLiveSessionLiveActivityWidget()
    }
}
#endif
