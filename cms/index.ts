import type { PageDefinition } from "@be-yours/cms"
import { cmsGroups } from "./groups"
import { signInPage } from "./pages/sign-in"
import { signUpPage } from "./pages/sign-up"
import { forgotPasswordPage } from "./pages/forgot-password"
import { homepagePage } from "./pages/homepage"
import { menuPage } from "./pages/menu"
import { cartPage } from "./pages/cart"
import { checkoutPage } from "./pages/checkout"
import { storeSelectorPage } from "./pages/store-selector"
import { accountPage } from "./pages/account"
import { accountOrdersPage } from "./pages/account-orders"
import { accountAddressesPage } from "./pages/account-addresses"
import { accountFavoritesPage } from "./pages/account-favorites"
import { orderTrackingPage } from "./pages/order-tracking"
import { productDetailPage } from "./pages/product-detail"
import { categoryMenuPage } from "./pages/category-menu"
import { gamePage } from "./pages/game"
import { storefrontLayoutPage } from "./pages/storefront-layout"
import { aboutPage } from "./pages/about"
import { blogPage } from "./pages/blog"
import { contactPage } from "./pages/contact"
import { legalNoticePage } from "./pages/legal-notice"
import { termsOfSalePage } from "./pages/terms-of-sale"
import { privacyPolicyPage } from "./pages/privacy-policy"

const pages: Record<string, PageDefinition> = {
  "sign-in": signInPage,
  "sign-up": signUpPage,
  "forgot-password": forgotPasswordPage,
  homepage: homepagePage,
  menu: menuPage,
  cart: cartPage,
  checkout: checkoutPage,
  "store-selector": storeSelectorPage,
  account: accountPage,
  "account-orders": accountOrdersPage,
  "account-addresses": accountAddressesPage,
  "account-favorites": accountFavoritesPage,
  "order-tracking": orderTrackingPage,
  "product-detail": productDetailPage,
  "category-menu": categoryMenuPage,
  game: gamePage,
  "storefront-layout": storefrontLayoutPage,
  about: aboutPage,
  blog: blogPage,
  contact: contactPage,
  "legal-notice": legalNoticePage,
  "terms-of-sale": termsOfSalePage,
  "privacy-policy": privacyPolicyPage,
}

export const appCmsConfig = {
  pages,
  groups: cmsGroups,
}
