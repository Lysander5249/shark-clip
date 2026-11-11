import CoreGraphics
import Foundation
import ImageIO

let output = URL(fileURLWithPath: CommandLine.arguments[1])
let sizes = [16, 32, 128, 256, 512]
let destination = CGImageDestinationCreateWithURL(output as CFURL, "com.apple.icns" as CFString,
                                                  sizes.count * 2, nil)!
let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!

for size in sizes {
    for scale in [1, 2] {
        let pixels = size * scale
        let context = CGContext(data: nil, width: pixels, height: pixels, bitsPerComponent: 8,
                                bytesPerRow: 0, space: colorSpace,
                                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        let unit = CGFloat(pixels) / 1024
        context.translateBy(x: 0, y: CGFloat(pixels))
        context.scaleBy(x: unit, y: -unit)
        let tile = CGRect(x: 80, y: 80, width: 864, height: 864)
        context.addPath(CGPath(roundedRect: tile, cornerWidth: 196, cornerHeight: 196, transform: nil))
        context.setFillColor(gray: 1, alpha: 1)
        context.fillPath()

        // The 100-point fin silhouette matches the standalone brand mark.
        context.translateBy(x: 244, y: 244)
        context.scaleBy(x: 5.36, y: 5.36)
        context.setFillColor(gray: 0, alpha: 1)
        context.move(to: CGPoint(x: 0, y: 100))
        context.addCurve(to: CGPoint(x: 62.5, y: 0), control1: CGPoint(x: 10, y: 54),
                         control2: CGPoint(x: 29, y: 15))
        context.addCurve(to: CGPoint(x: 66.5, y: 45.7), control1: CGPoint(x: 61, y: 14),
                         control2: CGPoint(x: 62, y: 29))
        context.addLine(to: CGPoint(x: 42.6, y: 63.8))
        context.addLine(to: CGPoint(x: 71, y: 59.7))
        context.addCurve(to: CGPoint(x: 100, y: 100), control1: CGPoint(x: 77, y: 77),
                         control2: CGPoint(x: 86.4, y: 90.6))
        context.closePath()
        context.fillPath()

        let dpi = 72 * scale
        let properties = [kCGImagePropertyDPIWidth: dpi, kCGImagePropertyDPIHeight: dpi] as CFDictionary
        CGImageDestinationAddImage(destination, context.makeImage()!, properties)
    }
}
guard CGImageDestinationFinalize(destination) else { fatalError("Unable to write \(output.lastPathComponent)") }
