import AppKit

// A small original branching-graph icon, rendered at every macOS icon size.
let destination = CommandLine.arguments[1]
let names = [(16, "16x16"), (32, "16x16@2x"), (32, "32x32"), (64, "32x32@2x"),
             (128, "128x128"), (256, "128x128@2x"), (256, "256x256"),
             (512, "256x256@2x"), (512, "512x512"), (1024, "512x512@2x")]
for (size, name) in names {
    let image = NSImage(size: NSSize(width: size, height: size))
    image.lockFocus()
    let transform = AffineTransform(scale: CGFloat(size) / 1024)
    (transform as NSAffineTransform).concat()
    let background = NSBezierPath(roundedRect: NSRect(x: 50, y: 50, width: 924, height: 924), xRadius: 215, yRadius: 215)
    NSColor(srgbRed: 0.13, green: 0.31, blue: 0.40, alpha: 1).setFill()
    background.fill()
    let line = NSBezierPath()
    line.move(to: NSPoint(x: 350, y: 260))
    line.line(to: NSPoint(x: 350, y: 530))
    line.curve(to: NSPoint(x: 670, y: 760), controlPoint1: NSPoint(x: 350, y: 705), controlPoint2: NSPoint(x: 670, y: 575))
    line.move(to: NSPoint(x: 350, y: 530))
    line.line(to: NSPoint(x: 350, y: 760))
    line.lineWidth = 44
    line.lineCapStyle = .round
    NSColor(srgbRed: 0.64, green: 0.81, blue: 0.82, alpha: 1).setStroke()
    line.stroke()
    for (x, y, terminal) in [(350.0, 260.0, false), (350.0, 530.0, false), (350.0, 760.0, false), (670.0, 760.0, true)] {
        (terminal ? NSColor(srgbRed: 0.94, green: 0.71, blue: 0.40, alpha: 1) : NSColor.white).setFill()
        NSBezierPath(ovalIn: NSRect(x: x - 62, y: y - 62, width: 124, height: 124)).fill()
    }
    image.unlockFocus()
    let bitmap = NSBitmapImageRep(data: image.tiffRepresentation!)!
    try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: "\(destination)/icon_\(name).png"))
}
