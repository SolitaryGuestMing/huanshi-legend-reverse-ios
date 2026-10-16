//
//  SceneDelegate.swift
//  幻世传说
//
//  iOS 场景生命周期宿主: 启动即把「幻世传说」模拟器 VC 作为根控制器显示。
//
import UIKit

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene,
               willConnectTo session: UISceneSession,
               options connectionOptions: UIScene.ConnectionOptions) {
        guard let ws = scene as? UIWindowScene else { return }
        let win = UIWindow(windowScene: ws)
        let nav = UINavigationController(rootViewController: HDBBKEmulatorViewController())
        nav.navigationBar.barStyle = .black
        nav.navigationBar.tintColor = .white
        win.rootViewController = nav
        win.makeKeyAndVisible()
        self.window = win
    }
}
