
import {
  removeNode, addDisposeCallback
} from 'tko.utils'

import {
  isObservable, unwrap
} from 'tko.observable'

import {
  contextFor, applyBindings
} from 'tko.bind'

import {
  NativeProvider
} from 'tko.provider.native'

const ORIGINAL_JSX_SYM = Symbol('Knockout - Original JSX')

/**
 *
 * @param {any} possibleJsx Test whether this value is JSX.
 *
 * True for
 *    { elementName }
 *    [{elementName}]
 *    observable({elementName} | [])
 *
 * Any observable will return truthy if its value is an array that doesn't
 * contain HTML elements.  Template nodes should not be observable unless they
 * are JSX.
 *
 * There's a bit of guesswork here that we could nail down with more test cases.
 */
export function maybeJsx (possibleJsx) {
  if (isObservable(possibleJsx)) { return true }
  const value = unwrap(possibleJsx)
  if (!value) { return false }
  if (value.elementName) { return true }
  if (!Array.isArray(value) || !value.length) { return false }
  if (value[0] instanceof window.Node) { return false }
  return true
}

/**
 * Clone a node from its original JSX if possible, otherwise using DOM cloneNode
 * This preserves any native attributes set by JSX.
 * @param {HTMLElemen} node
 * @return {HTMLElement} clone of node
 */
export function cloneNodeFromOriginal (node) {
  if (!node) { return [] }

  if (node[ORIGINAL_JSX_SYM]) {
    const possibleTemplate = jsxToNode(node[ORIGINAL_JSX_SYM])
    return [...possibleTemplate.content
      ? possibleTemplate.content.childNodes
      : possibleTemplate.childNodes]
  }

  if ('content' in node) {
    const clone = document.importNode(node.content, true)
    return [...clone.childNodes]
  }

  const nodeArray = Array.isArray(node) ? node : [node]
  return nodeArray.map(n => n.cloneNode(true))
}

/**
 * Use a JSX transpilation of the format created by babel-plugin-transform-jsx
 * @param {Object} jsx An object of the form
 *    { elementName: node-name e.g. "div",
 *      attributes: { "attr": "value", ... },
 *      children: [string | jsx]
 *    }
 */
export function jsxToNode (jsx) {
  if (typeof jsx === 'string') {
    return document.createTextNode(jsx)
  }

  const node = document.createElement(jsx.elementName)
  const subscriptions = []

  /** Slots need to be able to replicate with the attributes, which
   *  are not preserved when cloning from template nodes. */
  node[ORIGINAL_JSX_SYM] = jsx

  updateAttributes(node, unwrap(jsx.attributes), subscriptions)
  if (isObservable(jsx.attributes)) {
    subscriptions.push(jsx.attributes.subscribe(attrs => {
      updateAttributes(node, unwrap(attrs), subscriptions)
    }))
  }

  updateChildren(node, unwrap(jsx.children), subscriptions)
  if (isObservable(jsx.children)) {
    subscriptions.push(jsx.children.subscribe(children => {
      updateChildren(node, children, subscriptions)
    }))
  }

  if (subscriptions.length) {
    addDisposeCallback(node, () => subscriptions.map(s => s.dispose()))
  }

  return node
}

function getInsertTarget (possibleTemplateElement) {
  return 'content' in possibleTemplateElement
    ? possibleTemplateElement.content : possibleTemplateElement
}

/**
 *
 * @param {HTMLElement|HTMLTemplateElement} possibleTemplateElement
 * @param {Node} toAppend
 */
function appendChildOrChildren (possibleTemplateElement, toAppend) {
  if (Array.isArray(toAppend)) {
    for (const node of toAppend) {
      appendChildOrChildren(possibleTemplateElement, node)
    }
  } else {
    getInsertTarget(possibleTemplateElement).appendChild(toAppend)
  }
}

/**
 *
 * @param {HTMLElement|HTMLTemplateElement} possibleTemplateElement
 * @param {Node} toAppend
 * @param {Node} beforeNode
 */
function insertChildOrChildren (possibleTemplateElement, toAppend, beforeNode) {
  if (!beforeNode.parentNode) { return }

  if (Array.isArray(toAppend)) {
    for (const node of toAppend) {
      insertChildOrChildren(possibleTemplateElement, node, beforeNode)
    }
  } else {
    getInsertTarget(possibleTemplateElement).insertBefore(toAppend, beforeNode)
  }
}

/**
 *
 * @param {HTMLElement} node
 * @param {Array} children
 * @param {Array} subscriptions
 */
function updateChildren (node, children, subscriptions) {
  let lastChild = node.lastChild
  while (lastChild) {
    removeNode(lastChild)
    lastChild = node.lastChild
  }

  for (const child of children || []) {
    if (isObservable(child)) {
      subscriptions.push(monitorObservableChild(node, child))
    } else {
      appendChildOrChildren(node, convertJsxChildToDom(child))
    }
  }
}

/**
 *
 * @param {HTMLElement} node
 * @param {string} name
 * @param {any} valueOrObservable
 */
function setNodeAttribute (node, name, valueOrObservable) {
  const value = unwrap(valueOrObservable)
  NativeProvider.addValueToNode(node, name, valueOrObservable)
  if (typeof value === 'string') {
    node.setAttribute(name, value)
  } else if (value === undefined) {
    node.removeAttribute(name)
  }
}

/**
 *
 * @param {HTMLElement} node
 * @param {Object} attributes
 * @param {Array} subscriptions
 */
function updateAttributes (node, attributes, subscriptions) {
  while (node.attributes.length) {
    node.removeAttribute(node.attributes[0].name)
  }

  for (const [name, value] of Object.entries(attributes || {})) {
    if (isObservable(value)) {
      subscriptions.push(
        value.subscribe(attr => setNodeAttribute(node, name, value))
      )
    }
    setNodeAttribute(node, name, value)
  }
}

/**
 *
 * @param {jsx} newJsx
 * @param {HTMLElement|Array} toReplace
 * @return {HTMLElement|Array} Nodes to replace next time
 *
 * TODO: Use trackArrayChanges to minimize changes to the DOM and state-loss.
 */
function replaceNodeOrNodes (newJsx, toReplace, parentNode) {
  const newNodeOrNodes = convertJsxChildToDom(newJsx)
  const $context = contextFor(toReplace)
  const firstNodeToReplace = Array.isArray(toReplace)
    ? toReplace[0] || null : toReplace

  insertChildOrChildren(parentNode, newNodeOrNodes, firstNodeToReplace)

  if (Array.isArray(toReplace)) {
    for (const node of toReplace) { removeNode(node) }
  } else {
    removeNode(toReplace)
  }

  if ($context) {
    if (Array.isArray(newNodeOrNodes)) {
      for (const node of newNodeOrNodes) {
        applyBindings($context, node)
      }
    } else {
      applyBindings($context, newNodeOrNodes)
    }
  }
  return newNodeOrNodes
}

/**
 *
 * @param {HTMLElement} node
 * @param {jsx|Array} child
 */
function monitorObservableChild (node, child) {
  const jsx = unwrap(child)
  let toReplace = convertJsxChildToDom(jsx)
  appendChildOrChildren(node, toReplace)

  const subscription = child.subscribe(newJsx => {
    toReplace = replaceNodeOrNodes(newJsx, toReplace, node)
  })

  return subscription
}

/**
 * Convert a child to the anticipated HTMLElement(s).
 * @param {string|array|jsx} child
 * @return {Array|Comment|HTMLElement}
 */
function convertJsxChildToDom (child) {
  return Array.isArray(child)
    ? child.map(convertJsxChildToDom)
    : child ? jsxToNode(child)
      : document.createComment('[jsx placeholder]')
}