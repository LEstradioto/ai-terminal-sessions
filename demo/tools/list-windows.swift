import CoreGraphics
import Foundation

let includeOffscreen = CommandLine.arguments.contains("--all")
let options: CGWindowListOption = includeOffscreen
  ? [.optionAll, .excludeDesktopElements]
  : [.optionOnScreenOnly, .excludeDesktopElements]
guard let windows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
  exit(1)
}

for window in windows {
  let owner = window[kCGWindowOwnerName as String] as? String ?? ""
  guard owner == "Code" || owner == "Visual Studio Code" else { continue }
  let number = window[kCGWindowNumber as String] as? Int ?? 0
  let pid = window[kCGWindowOwnerPID as String] as? Int ?? 0
  let name = window[kCGWindowName as String] as? String ?? ""
  let layer = window[kCGWindowLayer as String] as? Int ?? -1
  let bounds = window[kCGWindowBounds as String] as? [String: Any] ?? [:]
  let x = bounds["X"] as? Int ?? 0
  let y = bounds["Y"] as? Int ?? 0
  let width = bounds["Width"] as? Int ?? 0
  let height = bounds["Height"] as? Int ?? 0
  print("\(number)\t\(pid)\t\(layer)\t\(x),\(y)\t\(width)x\(height)\t\(name)")
}
