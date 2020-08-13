import * as functions from 'firebase-functions'
import * as admin from 'firebase-admin'

admin.initializeApp()

const stripe = require('stripe')(functions.config().stripe.key)
const cors = require('cors')({origin: true})

const algoliasearch = require('algoliasearch')
const client = algoliasearch(functions.config().algolia.app_id, functions.config().algolia.api_key)

// Pagos

exports.onUserCreated = functions.database.ref('usuarios/{userId}')
    .onCreate(async (snapshot, context) => {
        const userId = context.params.userId
        const user = await admin.auth().getUser(userId)
        const customer = await stripe.customers.create({ email: user.email})
        return admin.database().ref(`usuarios/${userId}/forma-pago/customer_id`).set(customer.id)
    })

exports.request = functions.https.onRequest((request, response) => {
    cors(request, response, () => {
        response.set('Access-Control-Allow-Origin', '*');
        response.set('Access-Control-Allow-Credentials', 'true');
        const origen = request.body.origen
        const data = request.body.data
        if (origen === 'newCard') {
            return newCard(data)
            .then(res => response.status(200).send(res))
            .catch(err => response.status(400).send(err))
        } else {
            return cobra(data)
            .then((idOrder: string) => response.status(200).send(idOrder))
            .catch((err: any) => response.status(400).send(err))
        }
    })
})

function newCard(cliente: string): Promise<string> {
    return new Promise((resolve, reject) => {        
        return admin.database().ref(`usuarios/${cliente}/forma-pago/customer_id`).once('value')
        .then(snap => snap.val())
        .then(async (customer) => {
            const intent = await stripe.paymentIntents.create({
                amount: 10 * 100,
                currency: 'mxn',
                customer,
            })
            resolve(intent.client_secret)
            return null
        })
        .catch(err => reject(err))
    })
}

exports.onNewCard = functions.database.ref('usuarios/{uid}/forma-pago/historial/{idMethod}')
    .onCreate(async (snapshot, context) => {
        const uid = context.params.uid
        const idMethod = context.params.idMethod
        const pm = await stripe.paymentMethods.retrieve(idMethod)
        console.log(pm);
        const card = {
            forma: pm.card.last4,
            id: idMethod,
            tipo: pm.card.brand
        }
        return admin.database().ref(`usuarios/${uid}/forma-pago/historial/${idMethod}`).update(card)
    })

function cobra(pedido: Pedido): Promise<string> {
    return new Promise(async (resolve, reject) => {        
        try {
            const cusSub = await admin.database().ref(`usuarios/${pedido.cliente.uid}/forma-pago/customer_id`).once('value')
            const customer = cusSub.val()
            const paymentIntent = await stripe.paymentIntents.create({
              amount:  Math.round(pedido.total * 100),
              currency: 'mxn',
              customer,
              payment_method: pedido.formaPago.id,
              off_session: true,
              confirm: true,
            })
            resolve(paymentIntent.id)
        } catch (err) {
            // Error code will be authentication_required if authentication is needed
            console.log(err);
            console.log('Error code is: ', err.code)
            const paymentIntentRetrieved = await stripe.paymentIntents.retrieve(err.raw.payment_intent.id)
            const secret = paymentIntentRetrieved.client_secret
            const idMethod = paymentIntentRetrieved.last_payment_error.payment_method.id
            console.log('Secret ' + secret);
            console.log('idMethod ' + idMethod);
            console.log('PI retrieved: ', paymentIntentRetrieved.id)
            const error = {
                secret,
                idMethod,
            }
            reject(error)
        }
    })
}

export interface Item {
    id: string;
    name: string;
    unit_price: number;
    quantity: number;
}


// Lógica y desarrollo de pedidos
exports.pedidoCreado = functions.database.ref('usuarios/{uid}/pedidos/activos/{idPedido}')
    .onCreate(async (snapshot, context) => {
        const pedido: Pedido = snapshot.val()
        const idPedido = context.params.idPedido
        const idNegocio = pedido.negocio.idNegocio
        const categoria = pedido.categoria
        const negocio = pedido.negocio
        const region = await getRegion(idNegocio)
        const subCategorias = await getSubcategoria(idNegocio)
        pedido.productos.forEach(async (p) => {
            const vendido: MasVendido = {
                id: p.id,
                categoria,
                idNegocio,
                url: p.url,
                nombre: p.nombre,
                pasillo: p.pasillo,
                descripcion: p.descripcion,
                precio: p.precio ? p.precio : 1,
                nombreNegocio: negocio.nombreNegocio,
                agotado: p.agotado ? p.agotado : false,
                dosxuno: p.dosxuno ? p.dosxuno : false,
                descuento: p.descuento ? p.descuento : 0,
            }
            await admin.database().ref(`vendidos/${region}/todos/${p.id}/ventas`).transaction(ventas => ventas ? ventas + p.cantidad : p.cantidad)
            await admin.database().ref(`vendidos/${region}/categorias/${categoria}/${p.id}/ventas`).transaction(ventas => ventas ? ventas + p.cantidad : p.cantidad)
            for (const sub of subCategorias) {
                await admin.database().ref(`vendidos/${region}/subCategorias/${categoria}/${sub}/${p.id}/ventas`).transaction(ventas => ventas ? ventas + p.cantidad : p.cantidad)
                await admin.database().ref(`vendidos/${region}/subCategorias/${categoria}/${sub}/${p.id}`).update(vendido)
                if (p.pasillo === 'Ofertas') await admin.database().ref(`ofertas/${region}/subCategorias/${categoria}/${sub}/${p.id}/ventas`).transaction(ventas => ventas ? ventas + 1 : 1)
            }
            await admin.database().ref(`vendidos/${region}/categorias/${categoria}/${p.id}`).update(vendido)
            await admin.database().ref(`vendidos/${region}/todos/${p.id}`).update(vendido)
            if (p.pasillo === 'Ofertas') {
                await admin.database().ref(`ofertas/${region}/${categoria}/${p.id}/ventas`).transaction(ventas => ventas ? ventas + 1 : 1)
                await admin.database().ref(`ofertas/${region}/todas/${p.id}/ventas`).transaction(ventas => ventas ? ventas + 1 : 1)
            }
        })
        const date = await formatDate(pedido.createdAt)
        await admin.database().ref(`pedidos/activos/${idNegocio}/detalles/${idPedido}`).set(pedido)
        await admin.database().ref(`pedidos/activos/${idNegocio}/cantidad`).transaction(cantidad => cantidad ? cantidad + 1 : 1)
        await admin.database().ref(`pedidos/historial/${pedido.region}/por_fecha/${date}/${idPedido}`).set(pedido)
        await admin.database().ref(`pedidos/seguimiento_admin/${idPedido}`).set(pedido)
        return admin.database().ref(`tokens/${idNegocio}`).once('value')
        .then(data => {
            const token = data.val()
            if (token) return sendFCM(token, 'Plaza. Tienes un nuevo pedido',  `Total. ${pedido.total}. Forma de pago: ${pedido.formaPago.tipo}`)
            else return null
        })
        .catch(err => console.log(err))
    })

exports.pedidoAceptadoOrRepartidorAsignado = functions.database.ref('pedidos/activos/{idNegocio}/detalles/{idPedido}')
    .onUpdate(async (change, context) => {
        const idPedido = context.params.idPedido
        const after: Pedido = change.after.val()
        const before: Pedido = change.before.val()
        if (before === after) return null
        if (!before.recolectado && after.recolectado && before.avances === after.avances) return null
        let recienAceptado = false
        // Lógica pedido aceptado
        const idCliente = after.cliente.uid
        const date = await formatDate(after.createdAt)
        if (!before.aceptado && after.aceptado) {
            recienAceptado = true
            await admin.database().ref(`usuarios/${idCliente}/pedidos/activos/${idPedido}`).set(after)
            await admin.database().ref(`pedidos/historial/${after.region}/por_fecha/${date}/${idPedido}`).update(after)
            await admin.database().ref(`pedidos/activos/${after.negocio.idNegocio}/detalles/${idPedido}`).update(after)
            if (after.repartidor) await admin.database().ref(`pedidos/seguimiento_admin/${idPedido}`).remove()
            else await admin.database().ref(`pedidos/seguimiento_admin/${idPedido}`).update(after)
            admin.database().ref(`usuarios/${idCliente}/token`).once('value')
            .then(dataVal => dataVal ? dataVal.val() : null)
            .then(token => token ? sendPushNotification(token, `${after.negocio.nombreNegocio} está preparando tu pedido`) : null)
            .catch((err) => console.log(err))
        }

        // Lógica repartidor asignado
        const idNegocio = context.params.idNegocio
        if (before.repartidor !== after.repartidor && after.repartidor && !recienAceptado) {
            admin.database().ref(`pedidos/activos/${idNegocio}/detalles/${idPedido}`).once('value')
            .then(dataVal => dataVal.val())
            .then(async (pedido: Pedido) => {
                await admin.database().ref(`usuarios/${idCliente}/pedidos/activos/${idPedido}/repartidor`).transaction(rep => {
                    if (rep) {
                        const error = 'este pedido ya tiene repartidor'
                        throw error
                    } else return after.repartidor
                })
                await admin.database().ref(`asignados/${after.repartidor?.id}/${idPedido}`).update(pedido)
                await admin.database().ref(`pedidos/historial/${pedido.region}/por_fecha/${date}/${idPedido}`).update(pedido)
                await admin.database().ref(`pedidos/seguimiento_admin/${idPedido}`).remove()
                return admin.database().ref(`usuarios/${idCliente}/token`).once('value')
            })
            .then(tokenVal => tokenVal ? tokenVal.val() : null)
            .then(token => token ? sendPushNotification(token, 'Repartidor asignado: ' + after.repartidor?.nombre) : null)
            .catch(err => console.log(err))
        }

        if (before.cancelado_by_negocio !== after.cancelado_by_negocio && after.cancelado_by_negocio) {
            // if (after.idOrder) await doRefund(after)
            await admin.database().ref(`pedidos/historial/${after.region}/por_negocio/${after.negocio.idNegocio}/${date}/${idPedido}`).set(after)
            await admin.database().ref(`pedidos/historial/${after.region}/por_fecha/${date}/${idPedido}`).update(after)
            await admin.database().ref(`pedidos/activos/${after.negocio.idNegocio}/cantidad`).transaction(cantidad => cantidad ? cantidad - 1 : 0)
            await admin.database().ref(`pedidos/activos/${after.negocio.idNegocio}/detalles/${idPedido}`).remove()
            await admin.database().ref(`usuarios/${idCliente}/pedidos/activos/${idPedido}`).set(after)
            await admin.database().ref(`pedidos/seguimiento_admin/${idPedido}`).remove()
            admin.database().ref(`usuarios/${idCliente}/token`).once('value')
            .then(dataVal => dataVal ? dataVal.val() : null)
            .then(token => token ? sendPushNotification(token, `${after.negocio.nombreNegocio} ha rechazado el pedido`) : null)
            .catch((err) => console.log(err))
        }

        if (!before.avances && after.avances && !recienAceptado || before.avances && before.avances.length < after.avances.length && !recienAceptado) {
            await admin.database().ref(`pedidos/historial/${after.region}/por_fecha/${date}/${idPedido}`).update(after)
            await admin.database().ref(`usuarios/${idCliente}/pedidos/activos/${idPedido}`).update(after)
        }

        return null
    })

exports.onPedidoTerminado = functions.database.ref('asignados/{idRepartidor}/{idPedido}')
    .onDelete(async (snapshot, context) => {
        const idRepartidor = context.params.idRepartidor
        const idPedido = context.params.idPedido
        const pedido: Pedido = snapshot.val()
        if (pedido.entregado || pedido.cancelado_by_negocio || pedido.cancelado_by_repartidor || pedido.cancelado_by_user) {
            const date = await formatDate(pedido.createdAt)
            await admin.database().ref(`pedidos/historial/${pedido.region}/por_fecha/${date}/${idPedido}`).update(pedido)
            if (pedido.repartidor?.externo) await admin.database().ref(`pedidos/historial/${pedido.region}/por_repartidor/${idRepartidor}/${date}/${idPedido}`).set(pedido)
            await admin.database().ref(`pedidos/historial/${pedido.region}/por_negocio/${pedido.negocio.idNegocio}/${date}/${idPedido}`).set(pedido)
            await admin.database().ref(`pedidos/activos/${pedido.negocio.idNegocio}/cantidad`).transaction(cantidad => cantidad ? cantidad - 1 : 0)
            await admin.database().ref(`pedidos/activos/${pedido.negocio.idNegocio}/detalles/${pedido.id}`).remove()
            await admin.database().ref(`usuarios/${pedido.cliente.uid}/chat/status/${pedido.id}`).remove()
            await admin.database().ref(`usuarios/${pedido.cliente.uid}/chat/todos/${pedido.id}`).remove()
            await admin.database().ref(`usuarios/${pedido.cliente.uid}/chat/unread/${pedido.id}`).remove()
            await admin.database().ref(`usuarios/${pedido.cliente.uid}/pedidos/historial/${pedido.id}`).set(pedido)
            return admin.database().ref(`usuarios/${pedido.cliente.uid}/pedidos/activos/${pedido.id}`).remove()
        } else return null
    })

exports.onProdsRecolectados = functions.database.ref('asignados/{idRepartidor}/{idPedido}')
    .onUpdate(async (change, context) => {
        const idPedido = context.params.idPedido
        const after: Pedido = change.after.val()
        const before: Pedido = change.before.val()
        if (before === after) return null
        if (after.entregado) return null
        if (!before.recolectado && after.recolectado || !before.repartidor_llego && after.repartidor_llego) {
            const date = await formatDate(after.createdAt)
            await admin.database().ref(`pedidos/activos/${after.negocio.idNegocio}/detalles/${idPedido}`).update(after)
            await admin.database().ref(`pedidos/historial/${after.region}/por_fecha/${date}/${idPedido}`).update(after)
            await admin.database().ref(`usuarios/${after.cliente.uid}/pedidos/activos/${idPedido}`).update(after)
            
        }
        return null
    })

    //Repartidor externo

exports.onNewExternalRepartidor = functions.database.ref('nuevo_repartidor/{region}/{idRepartidor}')
    .onCreate(async (snapshot, context) => {
        const idRepartidor = context.params.idRepartidor
        const region = context.params.region
        const repartidor = snapshot.val()
        try {
            const newUser = await admin.auth().createUser({
                disabled: false,
                displayName: repartidor.preview.nombre,
                email: repartidor.detalles.user + '@spot.com',
                password: repartidor.detalles.pass,
                photoURL: repartidor.preview.foto,
            });
            repartidor.preview.id = newUser.uid
            repartidor.preview.calificaciones = 1
            repartidor.preview.promedio = 5
            await admin.database().ref(`repartidores_asociados_info/${region}/suspendidos/detalles/${idRepartidor}`).set(repartidor.detalles)
            await admin.database().ref(`repartidores_asociados_info/${region}/suspendidos/preview/${idRepartidor}`).set(repartidor.preview)
            await admin.database().ref(`regiones_repartidores_asociados/${idRepartidor}`).set(region)
            return admin.database().ref(`result/${region}/${idRepartidor}`).push('ok')
        } catch (error) {
            return admin.database().ref(`result/${region}/${idRepartidor}`).push(error.errorInfo.code)
        }
    })

exports.solicitaRepartidor = functions.database.ref('pedidos/repartidor_pendiente/{idNegocio}/{idPedido}')
    .onCreate(async (snapshot, context) => {
        const idPedido = context.params.idPedido
        const idNegocio = context.params.idNegocio
        const pedido: Pedido = snapshot.val()
        let repartidorId: string
        let historial_pedido: Pedido
        let repartidores: RepartidorAsociado[]
        const date = await formatDate(pedido.createdAt)
        let ganancia = pedido.envio + pedido.propina
        ganancia = pedido.banderazo ? ganancia + pedido.banderazo : ganancia
        if (pedido.solicitudes && pedido.solicitudes > 3) return
        let tokens: string[] = []
        pedido.notificados = []
        // Get repartidores asociados
        return admin.database().ref(`pedidos/repartidor_pendiente/${idNegocio}/${idPedido}`).remove()
        .then(() => admin.database().ref(`repartidores_asociados_info/${pedido.region}/preview`).orderByChild('activo').equalTo(true).once('value'))
        .then(snap => snap ? snap.val() : null)
        .then((snapRepartidores: RepartidorAsociado[]) => {
            if (snapRepartidores) return Object.values(snapRepartidores)
            else {
                const error = 'no_repartidores_available'
                throw error
            }
        })
        .then(async (repartidores_raw: RepartidorAsociado[]) => {
            repartidores = repartidores_raw.filter(r => r.token)
            if (repartidores.length === 0) {
                const error = 'no_repartidores_available'
                throw error
            }
            if (pedido.formaPago.forma === 'efectivo') {
                repartidores = repartidores_raw.filter(r => r.maneja_efectivo)
                if (repartidores.length === 0) {
                    const error = 'no_repartidores_available'
                    throw error
                }
            }
            for (const repartidor of repartidores) {
                if (!repartidor.last_notification) repartidor.last_notification = 0
                if (!repartidor.last_pedido) repartidor.last_pedido = 0
                if (!repartidor.pedidos_activos) repartidor.pedidos_activos = 0
            }
            repartidores.sort((a, b) => a.last_notification - b.last_notification)
            repartidorId = repartidores[0].id
            if (pedido.solicitudes && pedido.solicitudes === 3) {
                repartidores.forEach(r => {
                    if (r.token) tokens.push(r.token)
                    pedido.notificados.push(r.id)
                })
            }
            else tokens = repartidores[0].token ? [repartidores[0].token] : []
            return null
        })
        .then(() => admin.database().ref(`pedidos/historial/${pedido.region}/por_fecha/${date}/${idPedido}`).once('value'))
        .then(pedidoDate => pedidoDate ? pedidoDate.val() : null)
        .then(pedidoVal => historial_pedido = pedidoVal)
        .then(async () => {
            if(historial_pedido && historial_pedido.last_notificado) await admin.database().ref(`notifications/${historial_pedido.last_notificado}/${idPedido}`).remove()
            if(historial_pedido && historial_pedido.repartidor) {
                const error = 'este pedido ya tiene repartidor'
                throw error
            }
            return null
        })
        .then(() => tokens.length > 1 ? sendFCMPedido(tokens, 'Gana: $' + ganancia + ' MXN', pedido) : null)
        .then(() => pedido.last_notificado = repartidorId)
        .then(async () => {
            const ban = pedido.banderazo ? pedido.banderazo + pedido.envio : pedido.envio
            const notification = {
                idPedido: pedido.id,
                idNegocio: pedido.negocio.idNegocio,
                negocio: pedido.negocio.nombreNegocio,
                negocio_direccion: pedido.negocio.direccion.direccion,
                negocio_lat: pedido.negocio.direccion.lat.toString(),
                negocio_lng: pedido.negocio.direccion.lng.toString(),
                cliente: pedido.cliente.nombre,
                createdAt: pedido.createdAt.toString(),
                cliente_direccion: pedido.cliente.direccion.direccion,
                cliente_lat: pedido.cliente.direccion.lat.toString(),
                cliente_lng: pedido.cliente.direccion.lng.toString(),
                notificado: pedido.last_solicitud.toString(),
                ganancia: ban.toString(),
                propina: pedido.propina ? pedido.propina.toString() : '0',
                solicitudes: pedido.solicitudes ? pedido.solicitudes.toString() : '1'
            }
            if (pedido.solicitudes && pedido.solicitudes === 3) {
                for (const not of pedido.notificados) await admin.database().ref(`notifications/${not}/${idPedido}`).set(notification)
            } else await admin.database().ref(`notifications/${repartidorId}/${idPedido}`).set(notification)
            return null
        })
        .then(() => admin.database().ref(`repartidores_asociados_info/${pedido.region}/preview/${repartidorId}/last_notification`).set(pedido.last_solicitud))
        .then(() => admin.database().ref(`pedidos/historial/${pedido.region}/por_fecha/${date}/${idPedido}`).update(pedido))
        .catch(err => {
            if (err === 'no_repartidores_available') {
                // alerta Admin
            }
            console.log(err)
        })
    })

exports.pedidoTomadoRepartidor = functions.database.ref('pendientes_aceptacion/{idRepartidor}/{idPedido}')
    .onCreate(async (snapshot, context) => {
        const idPedido = context.params.idPedido
        const idRepartidor = context.params.idRepartidor
        const notificacion: NotificacionNuevoPedido = snapshot.val()
        let pedido: Pedido
        const date = await formatDate(notificacion.createdAt)
        return admin.database().ref(`pedidos/historial/${notificacion.region}/por_fecha/${date}/${idPedido}`).once('value')
        .then(snapPedido => snapPedido ? snapPedido.val() : null)
        .then(async (pedido_raw: Pedido) => {
            pedido = pedido_raw
            return admin.database().ref(`repartidores_asociados_info/${pedido.region}/preview/${idRepartidor}`).once('value')
        .then(repartidorVal => repartidorVal ? repartidorVal.val() : null)
        .then((repartidor: Repartidor) => {
            repartidor.externo = true
            pedido.repartidor = repartidor
            pedido.avances.push({
                concepto: 'Tu repartidor ha sido asignado y va en camino por tus productos',
                fecha: Date.now()
            })
            return admin.database().ref(`usuarios/${pedido.cliente.uid}/pedidos/activos/${pedido.id}/repartidor`).transaction(rep => {
                if (rep) {
                    throw sendFCM(repartidor.token, 'Plaza repartidores', 'El pedido ha sido tomado por otro repartidor')
                } else return repartidor
            })
        })
        .then(() => admin.database().ref(`asignados/${idRepartidor}/${pedido.id}`).set(pedido))
        .then(() => admin.database().ref(`pedidos/seguimiento_admin/${idPedido}`).remove())
        .then(() => admin.database().ref(`repartidores_asociados_info/${pedido.region}/preview/${idRepartidor}/last_pedido`).set(Date.now()))
        .then(() => admin.database().ref(`pedidos/historial/${notificacion.region}/por_fecha/${date}/${idPedido}`).update(pedido))
        .then(() => admin.database().ref(`pedidos/activos/${pedido.negocio.idNegocio}/detalles/${idPedido}`).update(pedido))
        .then(() => admin.database().ref(`notifications/${pedido.last_notificado}/${idPedido}`).remove())
        .then(async () => {
            if (pedido.notificados && pedido.notificados.length > 0) {
                for (const not of pedido.notificados) await admin.database().ref(`notifications/${not}/${idPedido}`).remove()
            }
            return null
        })
        .then(() => admin.database().ref(`pendientes_aceptacion/${idRepartidor}/${idPedido}`).remove())
        .then(() => admin.database().ref(`pedidos/activos/${pedido.negocio.idNegocio}/repartidor_pendiente/${idPedido}`).remove())
        })
        .catch(async (err) => {
            await admin.database().ref(`pendientes_aceptacion/${idRepartidor}/${idPedido}/${idPedido}`).remove()
            console.log(err)
        })
    })

function formatDate(stamp: number) {
    return new Promise((resolve, reject) => {        
        const dMX = new Date(stamp).toLocaleString("en-US", {timeZone: "America/Mexico_City"})
        const d = new Date(dMX)
        let month = '' + (d.getMonth() + 1)
        let day = '' + d.getDate()
        const year = d.getFullYear()
    
        if (month.length < 2) 
            month = '0' + month;
        if (day.length < 2) 
            day = '0' + day;
    
        resolve([year, month, day].join('-'))
    });
}
    // Chat

exports.onMsgClienteAdded = functions.database.ref(`usuarios/{userId}/chat/todos/{idPedido}/{msgId}`)
    .onCreate(async (snapshot, context) => {
        const idPedido = context.params.idPedido
        const userId = context.params.userId
        const msg: MensajeCliente = snapshot.val()
        if (!msg.isMe) {
            return;
        }
        if (msg.idRepartidor === 'soporte') {
            const unread = {
                foto: msg.foto,
                last_msg: msg.msg,
                nombre: msg.nombre,
                idUser: userId,
                cantidad: 1,
                idPedido: idPedido
            }
            delete msg.idPedido
            delete msg.idRepartidor
            if (msg.foto) unread.foto = msg.foto
            else delete unread.foto
            await admin.database().ref(`chat/soporte/unread/${userId}`).transaction(mensaje => {
                if (mensaje) {
                    mensaje.last_msg = msg.msg
                    mensaje.cantidad++
                    return mensaje
                } else {
                    return unread
                }
            })
            return  admin.database().ref(`chat/soporte/todos/${idPedido}`).push(msg) 
        } else {
            await admin.database().ref(`chat/${msg.idRepartidor}/todos/${idPedido}`).push(msg)
            await admin.database().ref(`chat/${msg.idRepartidor}/unread/${idPedido}/idPedido`).set(idPedido)
            await admin.database().ref(`chat/${msg.idRepartidor}/unread/${idPedido}/idCliente`).set(userId)
            return await admin.database().ref(`chat/${msg.idRepartidor}/unread/${idPedido}/cantidad`).transaction(cantidad => cantidad ? cantidad + 1 : 1)
        }
        ////////////////////// Sólo falta push notification
        // return admin.database().ref(`carga/${vendedorId}/datos/token`).once('value')
        //     .then(async (snap: any)  => {
        //     const token = snap ? snap.val() : 'No hay';
        //     sendMsg(token, msg, 'mensaje');
        //     }).catch((err) => { console.log(err); });
    })

exports.onMsgVendedorAdded = functions.database.ref(`chat/{idRepartidor}/todos/{idPedido}/{idMsg}`)
    .onCreate(async (snapshot, context) => {
        const msg: MensajeRepOSop = snapshot.val()
        if (msg.isMe) return
        const userId = msg.idCliente
        const idPedido = context.params.idPedido
        const idRepartidor = context.params.idRepartidor
        await admin.database().ref(`usuarios/${userId}/chat/todos/${idPedido}`).push(msg)
        await admin.database().ref(`usuarios/${userId}/chat/unread/${idPedido}/idPedido`).set(idPedido)
        await admin.database().ref(`usuarios/${userId}/chat/unread/${idPedido}/idRepartidor`).set(idRepartidor)
        await admin.database().ref(`usuarios/${userId}/chat/unread/${idPedido}/cantidad`).transaction(cantidad => cantidad ? cantidad + 1 : 1)
        return admin.database().ref(`usuarios/${userId}/token`).once('value')
        .then(dataVal => dataVal ? dataVal.val() : null)
        .then(token => token ? sendPushNotification(token, `Nuevo mensaje de ${msg.repartidor}`) : null)
        .catch((err) => console.log(err))
    })

exports.onMsgAdminVisto = functions.database.ref('chat/soporte/unread/{idUser}/cantidad')
    .onUpdate(async (change, context) => {
        const after = change.after.val()
        const before = change.before.val()
        if (before === after || after > 0) return null
        const idUser = context.params.idUser
        return admin.database().ref(`usuarios/${idUser}/chat/status/${idUser}`).set('visto')
    })

exports.onMsgVendedorVisto = functions.database.ref('chat/{idRepartidor}/unread/{idPedido}')
    .onDelete(async (snapshot, context) => {
        const info = snapshot.val()
        const ultimo_mensaje = await admin.database().ref(`usuarios/${info.idCliente}/chat/todos/${info.idPedido}`).orderByKey().limitToLast(1).once('value')
        const ultimo = ultimo_mensaje.val()
        if (ultimo) return admin.database().ref(`usuarios/${info.idCliente}/chat/status/${info.idPedido}`).set('visto')
        else return null
    })

exports.onMsgClienteVisto = functions.database.ref('usuarios/{idCliente}/chat/unread/{idPedido}')
    .onDelete(async (snapshot, context) => {
        const info = snapshot.val()
        const ultimo_mensaje = await admin.database().ref(`chat/${info.idRepartidor}/todos/${info.idPedido}`).orderByKey().limitToLast(1).once('value')
        const ultimo = ultimo_mensaje.val()
        if (ultimo) return admin.database().ref(`chat/${info.idRepartidor}/status/${info.idPedido}`).set('visto')
        else return null
    })

    // Lógica e interfaces Calificación

exports.onCalificacionAdded = functions.database.ref('usuarios/{idCliente}/pedidos/historial/{idPedido}/calificacion')
    .onCreate(async (snapshot, context) => {
        const calificacion: Calificacion = snapshot.val()
        const idPedido = context.params.idPedido
        const idNegocio = calificacion.negocio.idNegocio
        const idRepartidor = calificacion.repartidor.idRepartidor
        const region = calificacion.region
        const fecha = await formatDate(calificacion.creado)
        await admin.database().ref(`pedidos/historial/${region}/por_repartidor/${idRepartidor}/${fecha}/${idPedido}/calificacion`).set(calificacion)
        await admin.database().ref(`pedidos/historial/${region}/por_negocio/${idNegocio}/${fecha}/${idPedido}/calificacion`).set(calificacion)
        await admin.database().ref(`pedidos/historial/${region}/por_fecha/${fecha}/${idPedido}/calificacion`).set(calificacion)
        await admin.database().ref(`rate/detalles/${idNegocio}/${idPedido}`).update(calificacion.negocio)
        await admin.database().ref(`rate/resumen/${idNegocio}`).transaction(data => calificaNegocio(data, calificacion))
        if (calificacion.repartidor.externo) {
            await admin.database().ref(`repartidores_asociados_info/${region}/detalles/${idRepartidor}/comentarios/${idPedido}`).set(calificacion.repartidor)
            await admin.database().ref(`repartidores_asociados_info/${region}/preview/${idRepartidor}`).transaction(datoExt => calificaRepartidor(datoExt, calificacion))
        } else {
            await admin.database().ref(`repartidores/${idNegocio}/detalles/${idRepartidor}/comentarios/${idPedido}`).update(calificacion.repartidor)
            await admin.database().ref(`repartidores/${idNegocio}/preview/${idRepartidor}`).transaction(dato => calificaRepartidor(dato, calificacion))
        }
        return admin.database().ref(`functions/${region}/${idNegocio}`).once('value')
        .then(infoVal => infoVal.val())
        .then(async (info: InfoFunction) => {
            if (info.abierto) {
                for (const subCategoria of info.subCategoria) {
                    await admin.database().ref(`negocios/preview/${region}/${info.categoria}/${subCategoria}/abiertos/${idNegocio}`).transaction(datu => calificaNegocio(datu, calificacion))
                }
                return admin.database().ref(`negocios/preview/${region}/${info.categoria}/todos/abiertos/${idNegocio}`).transaction(dati => calificaNegocio(dati, calificacion))
            } else {
                for (const subCategoria of info.subCategoria) {
                    await admin.database().ref(`negocios/preview/${region}/${info.categoria}/${subCategoria}/cerrados/${idNegocio}`).transaction(date => calificaNegocio(date, calificacion))
                }
                return admin.database().ref(`negocios/preview/${region}/${info.categoria}/todos/cerrados/${idNegocio}`).transaction(datas => calificaNegocio(datas, calificacion))
            }
        })
        .then(async (transactionResult: any) => {
            if (transactionResult.committed) {
                const infoCali = transactionResult.snapshot.val()
                const cal = {
                    calificaciones: infoCali.calificaciones,
                    promedio: infoCali.promedio
                }
                return admin.database().ref(`functions/${region}/${idNegocio}`).update(cal)
            }
            return null
        })
        .catch(err => console.log(err))
    })

export interface Calificacion {
    creado: number;
    region: string;
    negocio: NegocioCalificacion;
    repartidor: RepartidorCalificacion;
}

export interface NegocioCalificacion {
    puntos: number;
    comentarios: string;
    idNegocio: string;
}

export interface RepartidorCalificacion {
    puntos: number;
    comentarios: string;
    idRepartidor: string;
    externo: boolean;
}

export interface ResumenNegocioCalificaciones {
    calificaciones: number;
    promedio: number;
}

function calificaRepartidor(data: RepartidorPreview, calificacion: Calificacion) {
    if (data) {
        if (data.promedio) {
            data.promedio = ((data.promedio * data.calificaciones) + calificacion.repartidor.puntos)
                / (data.calificaciones + 1)
        } else data.promedio = (5 + calificacion.repartidor.puntos) / 2

        if (data.calificaciones) data.calificaciones = data.calificaciones + 1
        else data.calificaciones = 2
    }
    return data
}

function calificaNegocio(data: ResumenNegocioCalificaciones, calificacion: Calificacion) {
    if (data) {
        if (data.promedio) {
            data.promedio = ((data.promedio * data.calificaciones) + calificacion.negocio.puntos)
                / (data.calificaciones + 1)
        } else data.promedio = (5 + calificacion.negocio.puntos) / 2

        if (data.calificaciones) data.calificaciones = data.calificaciones + 1
        else data.calificaciones = 2
    }
    return data
}

/////////////////// Búsqueda

exports.busqueda = functions.database.ref('busqueda/{region}/{idBusqueda}')
    .onCreate(async (snapshot, context) => {
        const query = snapshot.val()
        const region = context.params.region
        const idBusqueda = context.params.idBusqueda
        const queries = [
            {
                indexName: `productos_${region}`,
                query: query.texto,
                params: {
                    page: query.pagina,                 
                }
            },              
            {
                indexName: `servicios_${region}`,
                query: query.texto,
                params: {
                    page: query.pagina,                 
                }
            },            
            {
                indexName: `negocios_${region}`,
                query: query.texto,
                params: {
                    page: query.pagina,               
                }
            },
        ]
        return client.multipleQueries(queries)
        .then(async (res: any) => {
            const hitsProds = res.results[0].nbHits > 0 ? res.results[0].hits : 'no_results'
            const hitsServs = res.results[1].nbHits > 0 ? res.results[1].hits : 'no_results'
            const hitsNeg = res.results[2].nbHits > 0 ? res.results[2].hits : 'no_results' 
            await admin.database().ref(`busqueda_resultados/${region}/${idBusqueda}/productos/${query.pagina}`).set(hitsProds)
            await admin.database().ref(`busqueda_resultados/${region}/${idBusqueda}/servicios/${query.pagina}`).set(hitsServs)
            await admin.database().ref(`busqueda_resultados/${region}/${idBusqueda}/negocios/${query.pagina}`).set(hitsNeg)
            return admin.database().ref(`busqueda/${region}/${idBusqueda}`).remove()
        })
        .catch((err: any) => console.log(err))

    })

//////////////////// Propios de administración, registros

exports.nuevoNegocio = functions.database.ref('nuevo_negocio/{region}/{idTemporal}')
    .onCreate(async (snapshot, context) => {
        const region = context.params.region
        const idTemporal = context.params.idTemporal
        const negocio: NegocioPerfil = snapshot.val()
        try {
            const newPerfil = await admin.auth().createUser({
                disabled: false,
                displayName: negocio.nombre,
                email: negocio.correo,
                password: negocio.pass,
            })
            negocio.id = newPerfil.uid

                // Info perfil
            await admin.database().ref(`perfiles/${negocio.id}`).set(negocio)

                // Info pasillos
            let datosPasillo
            if (negocio.tipo === 'servicios') {
              datosPasillo = {
                portada: negocio.portada,
                telefono: negocio.telefono,
                whats: negocio.whats,
              }
            } else {
              datosPasillo = {
                portada: negocio.portada,
              }
            }
            await admin.database().ref(`negocios/pasillos/${negocio.categoria}/${negocio.id}`).update(datosPasillo)


                // Info detalles
            const detalles = {
            descripcion: negocio.descripcion,
            telefono: negocio.telefono
            }
            await admin.database().ref(`negocios/detalles/${negocio.categoria}/${negocio.id}`).update(detalles)

                // Info datos-pedido & preparacion if tipo productos
            if (negocio.tipo === 'productos') {
            const datosPedido = {
                envio: negocio.envio ? negocio.envio : 0,
                idNegocio: negocio.id,
                direccion: negocio.direccion,
                nombreNegocio: negocio.nombre,
                logo: negocio.logo,
                entrega: negocio.entrega,
                telefono: negocio.telefono,
                formas_pago: negocio.formas_pago,
                envio_gratis_pedMin: negocio.envio_gratis_pedMin ? negocio.envio_desp_pedMin : 0,
                repartidores_propios: negocio.repartidores_propios,
                envio_costo_fijo: negocio.envio_costo_fijo ? negocio.envio_costo_fijo : false
            }
            await admin.database().ref(`negocios/datos-pedido/${negocio.categoria}/${negocio.id}`).update(datosPedido)
            }
            if (negocio.preparacion && negocio.tipo === 'productos') {
                await admin.database().ref(`preparacion//${negocio.id}`).set(negocio.preparacion)
            }
                //Listoforo
            await admin.database().ref(`result_negocios/${region}/${idTemporal}`).push('ok')
            const index = client.initIndex('negocios_' + negocio.region)
            const negocioAlgolia: NegocioAlgolia = {
                abierto: false,
                categoria: negocio.categoria,
                logo: negocio.logo,
                nombre: negocio.nombre,
                objectID: negocio.id,
                productos: 0,
                subCategoria: negocio.subCategoria
            }
            return index.saveObject(negocioAlgolia)
        } catch (error) {
            return admin.database().ref(`result_negocios/${region}/${idTemporal}`).push(error.errorInfo.code)
        }
    })

exports.onNegocioDisplay = functions.database.ref('functions/{region}/{idNegocio}')
    .onCreate(async (snapshot, context) => {
        const region = context.params.region
        const negocio: InfoFunction = snapshot.val()
        for (const item of negocio.subCategoria) {
            await admin.database().ref(`categoriaSub/${region}/${negocio.categoria}/${item}/cantidad`).transaction(cantidad => cantidad ? cantidad + 1 : 1)
        }
        return null
    })

exports.onProdCreated = functions.database.ref('negocios/{tipo}/{categoria}/{idNegocio}/{pasillo}/{idProducto}')
    .onCreate(async (snapshot, context) => {
        const tipo = context.params.tipo
        const pasillo = context.params.pasillo
        const producto: Producto = snapshot.val()
        const categoria = context.params.categoria
        const idNegocio = context.params.idNegocio
        const region: string = await getRegion(idNegocio)
        const subs: string[] = await getSubcategoria(idNegocio)
        const nombreNegocio: string = await getNombreNegocio(idNegocio)
        if (pasillo === 'Ofertas') {
            for (const item of subs) {
                await admin.database().ref(`categoriaSub/${region}/${categoria}/${item}/ofertas`).transaction(ofertas => ofertas ? ofertas + 1 : 1)
            }
        }

        //Guarda (o actualiza si cambia de pasillo) en Algolia
        const index = client.initIndex(tipo + '_' + region)
        const prodAlgolia: ProductoAlgolia = {
            agotado: producto.agotado ? producto.agotado : false,
            descripcion: producto.descripcion,
            nombre: producto.nombre,
            objectID: producto.id,
            precio: producto.precio,
            idNegocio,
            url: producto.url,
            descuento: producto.descuento ? producto.descuento : 0,
            dosxuno: producto.dosxuno ? producto.dosxuno : false,
            categoria,
            nombreNegocio
        }
        return index.saveObject(prodAlgolia)
    })

exports.onProdEliminadoOrPasilloChange = functions.database.ref('negocios/{tipo}/{categoria}/{idNegocio}/{pasillo}/{idProducto}')
    .onDelete(async (snapshot, context) => {
        const idProducto = context.params.idProducto
        const idNegocio = context.params.idNegocio
        const categoria = context.params.categoria
        const pasillo = context.params.pasillo
        const tipo = context.params.tipo
        const region = await getRegion(idNegocio)
        const producto: Producto = snapshot.val()
        const subCategorias = await getSubcategoria(idNegocio)
        if (pasillo === 'Ofertas') {
            for (const item of subCategorias) {
                await admin.database().ref(`categoriaSub/${region}/${categoria}/${item}/ofertas`).transaction(ofertas => ofertas ? ofertas -1 : 0)
            }
        }
        if (tipo === 'productos' && !producto.mudar) {    
            await admin.database().ref(`vendidos/${region}/todos/${producto.id}`).remove()
            await admin.database().ref(`vendidos/${region}/categorias/${categoria}/${producto.id}`).remove()
            for (const item of subCategorias) {
                await admin.database().ref(`vendidos/${region}/subCategorias/${categoria}/${item}/${producto.id}`).remove()
            }
        }
        if (tipo === 'servicios' && !producto.mudar) {            
            await admin.database().ref(`vendidos-servicios/${region}/todos/${producto.id}`).remove()
            await admin.database().ref(`vendidos-servicios/${region}/categorias/${categoria}/${producto.id}`).remove()
            for (const item of subCategorias) {
                await admin.database().ref(`vendidos-servicios/${region}/subCategorias/${categoria}/${item}/${producto.id}`).remove()
            }
        }
        if (producto.mudar) {
            delete producto.mudar
            if (tipo === 'productos') {            
                return admin.database().ref(`vendidos/${region}/todos/${idProducto}`).once('value', async (snap) => {
                    if (snap.exists()) {
                        const p: MasVendido = snap.val()
                        const vendido: MasVendido = {
                            id: p.id,
                            categoria,
                            idNegocio,
                            ventas: p.ventas,
                            url: producto.url,
                            nombre: producto.nombre,
                            pasillo: producto.pasillo,
                            nombreNegocio: p.nombreNegocio,
                            descripcion: producto.descripcion,
                            precio: producto.precio ? producto.precio : 1,
                            agotado: producto.agotado ? producto.agotado : false,
                            dosxuno: producto.dosxuno ? producto.dosxuno : false,
                            descuento: producto.descuento ? producto.descuento : 0,
                        }
                        await admin.database().ref(`vendidos/${region}/todos/${producto.id}`).update(vendido)
                        await admin.database().ref(`vendidos/${region}/categorias/${categoria}/${producto.id}`).update(vendido)
                        for (const item of subCategorias) {
                            await admin.database().ref(`vendidos/${region}/subCategorias/${categoria}/${item}/${producto.id}`).update(vendido)
                        }
                        return null
                    }
                    else return null
                })
            }
            if (tipo === 'servicios') {            
                return admin.database().ref(`vendidos-servicios/${region}/todos/${idProducto}`).once('value', async (snap) => {
                    if (snap.exists()) {
                        const p: MasVendido = snap.val()
                        const consultado: MasVendido = {
                            id: p.id,
                            categoria,
                            idNegocio,
                            ventas: p.ventas,
                            url: producto.url,
                            nombre: producto.nombre,
                            pasillo: producto.pasillo,
                            nombreNegocio: p.nombreNegocio,
                            descripcion: producto.descripcion,
                            precio: producto.precio ? producto.precio : 1,
                            agotado: producto.agotado ? producto.agotado : false,
                            dosxuno: producto.dosxuno ? producto.dosxuno : false,
                            descuento: producto.descuento ? producto.descuento : 0,
                        }
                        await admin.database().ref(`vendidos-servicios/${region}/todos/${producto.id}`).update(consultado)
                        await admin.database().ref(`vendidos-servicios/${region}/categorias/${categoria}/${producto.id}`).update(consultado)
                        for (const item of subCategorias) {
                            await admin.database().ref(`vendidos-servicios/${region}/subCategorias/${categoria}/${item}/${producto.id}`).update(consultado)
                        }
                        return null
                    }
                    else return null
                })
            }
            return null
        } else {
            const index = client.initIndex(tipo + '_' + region)
            return index.deleteObject(producto.id)
        }
    })

exports.onProdEdit = functions.database.ref('negocios/{tipo}/{categoria}/{idNegocio}/{pasillo}/{idProducto}')
    .onUpdate(async (change, context) => {
        const idProducto = context.params.idProducto
        const idNegocio = context.params.idNegocio
        const categoria = context.params.categoria
        const subCategorias = await getSubcategoria(idNegocio)
        const tipo = context.params.tipo
        const after: Producto = change.after.val()
        const before: Producto = change.before.val()
        if (before === after) return null
        if (before.pasillo !== after.pasillo && after.mudar) return null
        const region = await getRegion(idNegocio)
        if (tipo === 'productos') {            
            await admin.database().ref(`vendidos/${region}/todos/${idProducto}`).once('value', async (snapshot) => {
                if (snapshot.exists()) {
                    const p: MasVendido = snapshot.val()
                    const vendido: MasVendido = {
                        id: p.id,
                        categoria,
                        idNegocio,
                        ventas: p.ventas,
                        url: after.url,
                        nombre: after.nombre,
                        pasillo: after.pasillo,
                        nombreNegocio: p.nombreNegocio,
                        descripcion: after.descripcion,
                        precio: after.precio ? after.precio : 1,
                        agotado: after.agotado ? after.agotado : false,
                        dosxuno: after.dosxuno ? after.dosxuno : false,
                        descuento: after.descuento ? after.descuento : 0,
                    }
                    await admin.database().ref(`vendidos/${region}/todos/${after.id}`).update(vendido)
                    await admin.database().ref(`vendidos/${region}/categorias/${categoria}/${after.id}`).update(vendido)
                    for (const item of subCategorias) {
                        await admin.database().ref(`vendidos/${region}/subCategorias/${categoria}/${item}/${after.id}`).update(vendido)
                    }
                    return null
                }
                else return null
            })
        }
        if (tipo === 'servicios') {            
            await admin.database().ref(`vendidos-servicios/${region}/${idProducto}`).once('value', async (snapshot) => {
                if (snapshot.exists()) {
                    const p: MasVendido = snapshot.val()
                    const consultado: MasVendido = {
                        id: p.id,
                        categoria,
                        idNegocio,
                        url: after.url,
                        ventas: p.ventas,
                        nombre: after.nombre,
                        pasillo: after.pasillo,
                        nombreNegocio: p.nombreNegocio,
                        descripcion: after.descripcion,
                        precio: after.precio ? after.precio : 1,
                        agotado: after.agotado ? after.agotado : false,
                        dosxuno: after.dosxuno ? after.dosxuno : false,
                        descuento: after.descuento ? after.descuento : 0,
                    }
                    await admin.database().ref(`vendidos-servicios/${region}/todos/${after.id}`).update(consultado)
                    await admin.database().ref(`vendidos-servicios/${region}/categorias/${categoria}/${after.id}`).update(consultado)
                    for (const item of subCategorias) {
                        await admin.database().ref(`vendidos-servicios/${region}/subCategorias/${categoria}/${item}/${after.id}`).update(consultado)
                    }
                    return null
                }
                else return null
            })
        }

        const index = client.initIndex(tipo + '_' + region)
        //Guarda (o actualiza si cambia de pasillo) en Algolia
        const prodAlgolia: ProductoAlgolia = {
            agotado: after.agotado ? after.agotado : false,
            descripcion: after.descripcion,
            nombre: after.nombre,
            objectID: after.id,
            precio: after.precio,
            url: after.url,
            idNegocio,
            descuento: after.descuento ? after.descuento : 0,
            dosxuno: after.dosxuno ? after.dosxuno : false,
            categoria,
            nombreNegocio: '',
        }
        delete prodAlgolia.categoria
        delete prodAlgolia.idNegocio
        delete prodAlgolia.nombreNegocio
        if (before.descripcion === after.descripcion) delete prodAlgolia.descripcion
        if (before.agotado === after.agotado) delete prodAlgolia.agotado
        if (before.nombre === after.nombre) delete prodAlgolia.nombre
        if (before.precio === after.precio) delete prodAlgolia.precio
        if (before.url === after.url) delete prodAlgolia.url
        if (!after.descuento) delete prodAlgolia.descuento
        if (!after.dosxuno) delete prodAlgolia.dosxuno
        return index.partialUpdateObject(prodAlgolia)
    })

exports.negocioEdit = functions.database.ref('perfiles/{idNegocio}')
    .onUpdate(async (change, context) => {
        const idNegocio = context.params.idNegocio
        const after: NegocioPerfil = change.after.val()
        const before: NegocioPerfil = change.before.val()
        if (before === after) return null
        const region: string = await getRegion(idNegocio)
        const categoria: string = await getCategoria(idNegocio)
            // Sumar y restar cantidad en SubCat
        
        if (JSON.stringify(before.subCategoria) !== JSON.stringify(after.subCategoria)) {
            for (const item of before.subCategoria) {
                await admin.database().ref(`categoriaSub/${region}/${categoria}/${item}/cantidad`).transaction(cantidad => cantidad ? cantidad - 1 : 0)
            }        
            for (const item of after.subCategoria) {
                await admin.database().ref(`categoriaSub/${region}/${categoria}/${item}/cantidad`).transaction(cantidad => cantidad ? cantidad + 1 : 1)
            }
    
                // Mover vendidos
            await admin.database().ref(`vendidos/${region}/todos`).orderByChild('idNegocio').equalTo(idNegocio).once('value', snapshot => {
                snapshot.forEach(child => {
                    const childData: MasVendido = child.val()
                    const childKey: string = child.key ? child.key : ''
                    admin.database().ref(`vendidos/${region}/todos/${childKey}`).update(childData)
                    .then(async() => {
                        for (const item of before.subCategoria) {
                            await admin.database().ref(`vendidos/${region}/subCategorias/${childData.categoria}/${item}/${childData.id}`).remove()
                        }
                    })
                    .then(async () => {
                        for (const item of after.subCategoria) {
                            await admin.database().ref(`vendidos/${region}/subCategorias/${childData.categoria}/${item}/${childData.id}`).update(childData)
                        }
                    })
                    .catch(err => console.log(err))
                })
            })
    
                // Mover ofertas
            await admin.database().ref(`ofertas/${region}/todas`).orderByChild('idNegocio').equalTo(idNegocio).once('value', snapshot => {
                snapshot.forEach(child => {
                    const childData: Oferta = child.val()
                    admin.database().ref(`ofertas/${region}/todas/${childData.id}`).update(childData)
                    .then(async() => {
                        for (const item of before.subCategoria) {
                            await admin.database().ref(`categoriaSub/${region}/${categoria}/${item}/ofertas`).transaction(ofertas => ofertas ? ofertas -1 : 0)
                            await admin.database().ref(`ofertas/${region}/subCategorias/${childData.categoria}/${item}/${childData.id}`).remove()
                        }
                    })
                    .then(async() => {
                        for (const item of after.subCategoria) {
                            await admin.database().ref(`categoriaSub/${region}/${categoria}/${item}/ofertas`).transaction(ofertas => ofertas ? ofertas + 1 : 1)
                            await admin.database().ref(`ofertas/${region}/subCategorias/${childData.categoria}/${item}/${childData.id}`).update(childData)
                        }
                    })
                    .catch(err => console.log(err))
                })
            })
    
                // Mover consultados
            await admin.database().ref(`vendidos-servicios/${region}/todos`).orderByChild('idNegocio').equalTo(idNegocio).once('value', snapshot => {
                snapshot.forEach(child => {
                    const childData = child.val()
                    const childKey: string = child.key ? child.key : ''
                    admin.database().ref(`vendidos-servicios/${region}/todos/${childKey}`).update(childData)
                    .then(async () => {
                        for (const item of before.subCategoria) {
                            await admin.database().ref(`vendidos-servicios/${region}/subCategorias/${childData.categoria}/${item}/${childData.id}`).remove()
                        }
                    })
                    .then(async () => {
                        for (const item of after.subCategoria) {
                            await admin.database().ref(`vendidos-servicios/${region}/subCategorias/${childData.categoria}/${item}/${childData.id}`).update(childData)
                        }
                    })
                    .catch(() => null)
                })
            })
        }
        const negocioAlgolia: NegocioAlgolia = {
            abierto: false,
            categoria,
            logo: after.logo,
            nombre: after.nombre,
            objectID: after.id,
            productos: after.productos,
            subCategoria: after.subCategoria
        }
        const index = client.initIndex('negocios_' + region)
        delete negocioAlgolia.abierto
        if (before.categoria === after.categoria) delete negocioAlgolia.categoria
        if (before.logo === after.logo) delete negocioAlgolia.logo
        if (before.nombre === after.nombre) delete negocioAlgolia.nombre
        if (before.productos === after.productos) delete negocioAlgolia.productos
        if (JSON.stringify(before.subCategoria) === JSON.stringify(after.subCategoria)) delete negocioAlgolia.subCategoria
        return index.partialUpdateObject(negocioAlgolia)
    })

function getCategoria(idNegocio: string): Promise<string> {
    return new Promise((resolve, reject) => {
        admin.database().ref(`perfiles/${idNegocio}/categoria`).once('value')
        .then(region => resolve(region.val()))
        .catch(err => {
            console.log(err)
            reject(err)
        })
    })
}

function getNombreNegocio(idNegocio: string): Promise<string> {
    return new Promise((resolve, reject) => {
        admin.database().ref(`perfiles/${idNegocio}/nombre`).once('value')
        .then(region => resolve(region.val()))
        .catch(err => {
            console.log(err)
            reject(err)
        })
    })
}

exports.onNewRepartidor = functions.database.ref('nuevoColaborador/{idNegocio}/{idColaborador}')
    .onCreate(async (snapshot, context) => {
        const idNegocio = context.params.idNegocio
        const repartidor = snapshot.val()
        try {
            const newUser = await admin.auth().createUser({
                disabled: false,
                displayName: repartidor.preview.nombre,
                email: repartidor.detalles.correo,
                password: repartidor.detalles.pass,
                photoURL: repartidor.preview.foto || null,
                emailVerified: true,
            });
            repartidor.preview.id = newUser.uid
            repartidor.preview.calificaciones = 1
            repartidor.preview.promedio = 5
            await admin.database().ref(`repartidores/${idNegocio}/preview/${repartidor.preview.id}`).set(repartidor.preview)
            await admin.database().ref(`repartidores/${idNegocio}/detalles/${repartidor.preview.id}`).set(repartidor.detalles)
            return admin.database().ref(`result/${idNegocio}`).push('ok')
        } catch (error) {
            return admin.database().ref(`result/${idNegocio}`).push(error.errorInfo.code)
        }
    })

exports.onPassChanged = functions.database.ref('repartidores/{idNegocio}/detalles/{idRepartidor}/pass')
    .onUpdate(async (change, context) => {
        const idColaborador = context.params.idColaborador
        const after = change.after.val()
        const before = change.before.val()
        if (before === after) console.log('Pass didnt change')
        return await admin.auth().updateUser(idColaborador, { password: after })
    })

exports.onDisplayNameChanged = functions.database.ref('repartidores/{idNegocio}/detalles/{idRepartidor}/user')
    .onUpdate(async (change, context) => {
        const idColaborador = context.params.idColaborador
        const after = change.after.val()
        const before = change.before.val()
        if (before === after) return null
        return await admin.auth().updateUser(idColaborador, { displayName: after })
    })

exports.onFotoChanged = functions.database.ref('repartidores/{idNegocio}/preview/{idRepartidor}/foto')
    .onUpdate(async (change, context) => {
        const idColaborador = context.params.idColaborador
        const after = change.after.val()
        const before = change.before.val()
        if (before === after) return null
        return await admin.auth().updateUser(idColaborador, { photoURL: after })
    })

exports.onRepartidorDeleted = functions.database.ref('repartidores/{idNegocio}/detalles/{idColaborador}')
    .onDelete(async (snapshot, context) => {
        const idColaborador = context.params.idColaborador
        return admin.auth().deleteUser(idColaborador)
    })

exports.checkIsOpen = functions.pubsub.schedule('every 15 minutes').onRun(async (context) => {
    const dateMX = new Date().toLocaleString("en-US", {timeZone: "America/Mexico_City"})
    const date = new Date(dateMX)
    let dia = date.getDay()
    if (dia === 0) {
      dia = 6
    } else {
      dia--
    }
    let ahora = 0
    const horas = date.getHours()
    const horasEnMin = horas * 60
    const minutos = date.getMinutes()
    ahora = minutos + horasEnMin
    try {
        const negociosActivos = await admin.database().ref(`horario/analisis/${dia}`).orderByChild('activo').equalTo(true).once('value')
        Object.entries(negociosActivos.val()).forEach((n: any) => {
            if (n[1].activo &&
                n[1].apertura < ahora &&
                n[1].cierre > ahora) {
                // Dentro del horario, comprobar si tiene horario de comida
                if (n[1].inicioComida &&
                    n[1].finComida ) {
                    // Dentro del horario y cierra por comida, comprobemos si no está en tiempo de comida
                    if (n[1].inicioComida &&
                    n[1].inicioComida < ahora &&
                    n[1].finComida &&
                    n[1].finComida > ahora) {       
                        // Está dentro del horario de comida, comprobar si está cerrado
                        if (n[1].abierto) {
                            return cierraNegocio(n[0], dia.toString())
                        } else {
                            return null
                        }
                    } else {
                        // No están en horario de comida, comprobemos si está abierto
                        if (!n[1].abierto) {
                            return abreNegocio(n[0], dia.toString())
                        } else {
                            return null
                        }
                    }
                } else {
                    // Dentro del horario y es corrido, comprobar si está abierto
                    if (!n[1].abierto) {
                        return abreNegocio(n[0], dia.toString())
                    } else {
                        return null
                    }
                }
            } else {
                // Está fuera del horario, comprobar si está cerrado
                if (n[1].abierto) {
                    return cierraNegocio(n[0], dia.toString())
                } else {
                    return null
                }
            }
        });
        return null
    } catch (error) {
        console.log(error)
        return null
    }
})


    //No utilizadas

exports.onCategoriaEdit = functions.database.ref('perfiles/{idNegocio}/categoria')
    .onUpdate(async (change, context) => {
        const idNegocio = context.params.idNegocio
        const after: string = change.after.val()
        const before: string = change.before.val()
        const subCategorias = await getSubcategoria(idNegocio)
        if (before === after) return null
        const region = await getRegion(idNegocio)
        await admin.database().ref(`vendidos/${region}/todos`).orderByChild('idNegocio').equalTo(idNegocio).once('value', snapshot => {
            snapshot.forEach(child => {
                const childData: MasVendido = child.val()
                const childKey = child.key
                childData.categoria = after
                admin.database().ref(`vendidos/${region}/todos/${childKey}`).update(childData)
                .then(() => admin.database().ref(`vendidos/${region}/categorias/${after}/${childData.id}`).update(childData))
                .then(async () => {
                    for (const item of subCategorias) {
                        await admin.database().ref(`vendidos/${region}/subCategorias/${after}/${item}/${childData.id}`).update(childData)
                    }
                })
                .catch(() => null)
            })
        })
        return admin.database().ref(`vendidos-servicios/${region}/todos`).orderByChild('idNegocio').equalTo(idNegocio).once('value', snapshot => {
            snapshot.forEach(child => {
                const childData: MasVendido = child.val()
                const childKey = child.key
                childData.categoria = after
                admin.database().ref(`vendidos-servicios/${region}/todos/${childKey}`).update(childData)
                .then(() => admin.database().ref(`vendidos-servicios/${region}/categorias/${after}/${childData.id}`).update(childData))
                .then(async () => {
                    for (const item of subCategorias) {
                        await admin.database().ref(`vendidos-servicios/${region}/subCategorias/${after}/${item}/${childData.id}`).update(childData)
                    }
                })
                .catch(() => null)
            })
        })
    })

exports.onNombreNegocioEdit = functions.database.ref('perfiles/{idNegocio}/nombre')
    .onUpdate(async (change, context) => {
        const idNegocio = context.params.idNegocio
        const after = change.after.val()
        const before = change.before.val()
        if (before === after) return null
        const region = await getRegion(idNegocio)
        const subCategorias = await getSubcategoria(idNegocio)
        await admin.database().ref(`vendidos/${region}/todos`).orderByChild('idNegocio').equalTo(idNegocio).once('value', snapshot => {
            snapshot.forEach(child => {
                const childData = child.val()
                const childKey = child.key
                childData.nombreNegocio = after
                admin.database().ref(`vendidos/${region}/todos/${childKey}`).update(childData)
                .then(() => admin.database().ref(`vendidos/${region}/categorias/${childData.categoria}/${childData.id}`).update(childData))
                .then(async () => {
                    for (const item of subCategorias) {
                        await admin.database().ref(`vendidos/${region}/subCategorias/${childData.categoria}/${item}/${childData.id}`).update(childData)
                    }
                })
                .catch(() => null)
            })
        })
        return admin.database().ref(`vendidos-servicios/${region}/todos`).orderByChild('idNegocio').equalTo(idNegocio).once('value', snapshot => {
            snapshot.forEach(child => {
                const childData = child.val()
                const childKey = child.key
                childData.nombreNegocio = after
                admin.database().ref(`vendidos-servicios/${region}/todos/${childKey}`).update(childData)
                .then(() => admin.database().ref(`vendidos-servicios/${region}/categorias/${childData.categoria}/${childData.id}`).update(childData))
                .then(async () => {
                    for (const item of subCategorias) {
                        await admin.database().ref(`vendidos-servicios/${region}/subCategorias/${childData.categoria}/${item}/${childData.id}`).update(childData)
                    }
                })
                .catch(() => null)
            })
        })
    })

// Functions

async function cierraNegocio(idNegocio: string, dia: string) {
    let categoria = ''
    let subCategoria: any = []
    let datosNegocio: any = {}
    const region = await getRegion(idNegocio)
    admin.database().ref(`functions/${region}/${idNegocio}`).once('value')
                    .then(inf => {
                        const info = inf.val()
                        categoria = info.categoria
                        subCategoria = info.subCategoria
                        return admin.database().ref(`negocios/preview/${region}/${info.categoria}/todos/abiertos/${idNegocio}`).once('value')})
                    .then(res => {
                        datosNegocio = res.val()
                        datosNegocio.abierto = false
                        return admin.database().ref(`negocios/preview/${region}/${categoria}/todos/cerrados/${idNegocio}`).update(datosNegocio)})
                    .then(async () => {
                        for (const s of subCategoria) {
                            await admin.database().ref(`negocios/preview/${region}/${categoria}/${s}/cerrados/${idNegocio}`).update(datosNegocio)
                        }
                        return null
                    })
                    .then(() =>admin.database().ref(`negocios/preview/${region}/${categoria}/todos/abiertos/${idNegocio}`).remove())
                    .then(async () => {
                        for (const s of subCategoria) {
                            await admin.database().ref(`negocios/preview/${region}/${categoria}/${s}/abiertos/${idNegocio}`).remove()
                        }
                        return null
                    })
                    .then(() => admin.database().ref(`horario/analisis/${dia}/${idNegocio}`).update({abierto: false}))
                    .then(() => admin.database().ref(`functions/${region}/${idNegocio}`).update({abierto: false}))
                    .then(() => admin.database().ref(`isOpen/${region}/${idNegocio}/abierto`).set(false))
                    .then(() => {
                        const negocioAlgolia = {
                            abierto: false,
                            objectID: idNegocio,
                        }
                        const index = client.initIndex('negocios_' + region)
                        return index.partialUpdateObject(negocioAlgolia)
                    })
                    .catch(err => console.log(err))
}

async function abreNegocio(idNegocio: string, dia: string) {
    let categoria = ''
    let subCategoria: any = []
    let datosNegocio: any = {}
    const region = await getRegion(idNegocio)
    admin.database().ref(`functions/${region}/${idNegocio}`).once('value')
                    .then(inf => {
                        const info = inf.val()
                        categoria = info.categoria
                        subCategoria = info.subCategoria
                        return admin.database().ref(`negocios/preview/${region}/${info.categoria}/todos/cerrados/${idNegocio}`).once('value')
                        
                    }).then(res => {
                        datosNegocio = res.val()
                        datosNegocio.abierto = true
                        return admin.database().ref(`negocios/preview/${region}/${categoria}/todos/abiertos/${idNegocio}`).update(datosNegocio)
                    }).then(async () => {
                        for (const s of subCategoria) {
                            await admin.database().ref(`negocios/preview/${region}/${categoria}/${s}/abiertos/${idNegocio}`).update(datosNegocio)
                        }
                        return null
                    })
                    .then(() => admin.database().ref(`negocios/preview/${region}/${categoria}/todos/cerrados/${idNegocio}`).remove())
                    .then(async () => {
                        for (const s of subCategoria) {
                            await admin.database().ref(`negocios/preview/${region}/${categoria}/${s}/cerrados/${idNegocio}`).remove()
                        }
                        return null
                    })
                    .then(() =>admin.database().ref(`horario/analisis/${dia}/${idNegocio}`).update({abierto: true}))
                    .then(() => admin.database().ref(`functions/${region}/${idNegocio}`).update({abierto: true}))
                    .then(() => admin.database().ref(`isOpen/${region}/${idNegocio}/abierto`).set(true))
                    .then(() => {
                        const negocioAlgolia = {
                            abierto: true,
                            objectID: idNegocio,
                        }
                        const index = client.initIndex('negocios_' + region)
                        return index.partialUpdateObject(negocioAlgolia)
                    })
                    .catch(err => console.log(err))
}

function sendPushNotification(token: string, msn: string) {
    const sendNotification = function(msg: any) {
        const headers = { "Content-Type": "application/json; charset=utf-8" }
        
        const options = {
          host: "onesignal.com",
          port: 443,
          path: "/api/v1/notifications",
          method: "POST",
          headers: headers
        };
        
        const https = require('https')
        const req = https.request(options, function(res: any) {  
          res.on('data', function(resp: any) {
            console.log("Response:")
            console.log(JSON.parse(resp))
          });
        });
        
        req.on('error', function(e: any) {
          console.log("ERROR:")
          console.log(e)
        });
        
        req.write(JSON.stringify(msg))
        req.end()
    }

    const message = { 
        app_id: "0450c0cf-ee73-4fcf-ac05-53a355468933",
        contents: {"en": msn},
        include_player_ids: [token],
        
    }
      
    sendNotification(message)
}

function sendFCM(token: string, title: string, mensaje: string) {
    const payload: admin.messaging.MessagingPayload = {
        notification: {
            title,
            body: mensaje,
            click_action: 'https://revistaojo-9a8d3.firebaseapp.com',
            icon: 'https://firebasestorage.googleapis.com/v0/b/revistaojo-9a8d3.appspot.com/o/logotipos%2Fic_stat_onesignal_default.png?alt=media&token=be09f858-6a1c-4a52-b5ad-717e1eac1d50'
        }
      };
      const options = {
          priority: "high"
      }
      return admin.messaging().sendToDevice(token, payload, options)
}

function sendFCMPedido(token: string[], mensaje: string, pedido: Pedido) {
    const ban = pedido.banderazo ? pedido.banderazo + pedido.envio : pedido.envio
    const payload: admin.messaging.MessagingPayload = {
        notification: {
            title: 'Plaza. Pedido disponible',
            body: mensaje,
            click_action: 'https://revistaojo-9a8d3.firebaseapp.com',
            icon: 'https://firebasestorage.googleapis.com/v0/b/revistaojo-9a8d3.appspot.com/o/logotipos%2Fic_stat_onesignal_default.png?alt=media&token=be09f858-6a1c-4a52-b5ad-717e1eac1d50'
        },
        data: {
            idPedido: pedido.id,
            idNegocio: pedido.negocio.idNegocio,
            negocio: pedido.negocio.nombreNegocio,
            negocio_direccion: pedido.negocio.direccion.direccion,
            negocio_lat: pedido.negocio.direccion.lat.toString(),
            negocio_lng: pedido.negocio.direccion.lng.toString(),
            cliente: pedido.cliente.nombre,
            cliente_direccion: pedido.cliente.direccion.direccion,
            cliente_lat: pedido.cliente.direccion.lat.toString(),
            cliente_lng: pedido.cliente.direccion.lng.toString(),
            createdAt: pedido.createdAt.toString(),
            notificado: pedido.last_solicitud.toString(),
            ganancia: ban.toString(),
            propina: pedido.propina ? pedido.propina.toString() : '0',
            solicitudes: pedido.solicitudes ? pedido.solicitudes.toString() : '1'
        }
      };
      const options = {
          priority: "high"
      }
      return admin.messaging().sendToDevice(token, payload, options)
}

function getRegion(idNegocio: string): Promise<string> {
    return new Promise((resolve, reject) => {
        admin.database().ref(`perfiles/${idNegocio}/region`).once('value')
        .then(region => resolve(region.val()))
        .catch(err => {
            console.log(err)
            reject(err)
        })
    })
}

function getSubcategoria(idNegocio: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
        admin.database().ref(`perfiles/${idNegocio}/subCategoria`).once('value')
        .then(subCategoria => resolve(subCategoria.val()))
        .catch(err => {
            console.log(err)
            reject(err)
        })
    })
}

export interface Avance {
    fecha: number;
    concepto: string;
}

export interface ClienteToken {
    token: string;
    idCliente: string;
    name: string;
}

export interface NegocioPerfil {
    autorizado: boolean
    categoria: string
    contacto: string
    correo: string
    plan: string
    descripcion: string
    direccion: Direccion
    entrega: string
    envio?: number
    formas_pago: FormaPago
    id: string
    logo: string
    nombre: string
    pass: string
    portada: string
    preparacion?: number
    productos: number
    region: string
    subCategoria: string[]
    telefono: string
    tipo: string
    whats?: string
    repartidores_propios: boolean
    envio_gratis_pedMin?: number
    envio_costo_fijo?: boolean
    envio_desp_pedMin?: number
    source: string
    objectID: string
}

export interface NegocioAlgolia {
    logo: string;
    nombre: string;
    objectID: string;
    abierto: boolean;
    categoria: string;
    productos: number;
    subCategoria: string[];
}

export interface ProductoAlgolia {
    agotado: boolean;
    url: string;
    precio: number;
    nombre: string;
    objectID: string;
    descripcion: string;
    descuento: number;
    dosxuno: boolean;
    idNegocio: string;
    categoria: string;
    nombreNegocio: string;
}

export interface Pedido {
    aceptado: number;
    avances: Avance[];
    categoria: string;
    cliente: Cliente;
    createdAt: number;
    entrega: string;
    entregado?: number;
    envio: number;
    propina: number;
    fecha: string;
    formaPago: FormaPago;
    id: string;
    negocio: Negocio;
    productos: Producto[];
    region: string;
    total: number;
    last_notification: number;
    last_notificado: string;
    last_solicitud: number;
    notificados: string[];
    repartidor?: Repartidor;
    cancelado_by_user?: number;
    cancelado_by_negocio?: number;
    cancelado_by_repartidor?: number;
    razon_cancelacion?: string;
    idOrder?: string;
    comision: number;
    recolectado?: boolean;
    banderazo?: number;
    repartidor_llego: boolean;
    solicitudes?: number;
}

export interface InfoFunction {
    abierto: boolean
    calificaicones: number
    categoria: string
    plan: string
    foto: string
    idNegocio: string
    nombre: string
    promedio: number
    subCategoria: string[]
    tipo: string
    visitas: number
}

export interface Repartidor {
    nombre: string;
    telefono: string;
    foto: string;
    lat: number;
    lng: number;
    id: string;
    externo: boolean;
    token: string;
}

export interface RepartidorAsociado {
    nombre: string;
    telefono: string;
    lat: number;
    lng: number;
    last_pedido: number;
    last_notification: number;
    pedidos_activos: number;
    distancia: number;
    token: string;
    id: string;
    promedio: number;
    maneja_efectivo: boolean;
}

export interface Negocio {
    categoria: string;
    direccion: Direccion;
    envio: number;
    idNegocio: string;
    logo: string;
    nombreNegocio: string;
    telefono: string;
}

export interface Direccion {
    direccion: string;
    lat: number;
    lng: number;
}

export interface FormaPago {
    forma: string;
    tipo: string;
    id: string;
}

export interface Cliente {
    direccion: Direccion;
    nombre: string;
    telefono: string;
    uid: string;
}

export interface Producto {
    agotado?: boolean;
    codigo: string;
    descripcion: string;
    id: string;
    nombre: string;
    pasillo: string;
    precio: number;
    unidad: string;
    url: string;
    variables: boolean;
    cantidad?: number;
    complementos?: ListaComplementosElegidos[];
    observaciones?: string;
    objectID: string;
    total: number;
    descuento?: number;
    dosxuno?: boolean;
    mudar?: boolean;
    nuevo: boolean;
    source: string
}

export interface Oferta {
    categoria: string;
    foto: string;
    id: string;
    idNegocio: string;
    abierto: boolean;
}

export interface MasVendido {
    agotado: boolean;
    categoria: string;
    descripcion: string;
    id: string;
    idNegocio: string;
    nombre: string;
    nombreNegocio: string;
    pasillo: string;
    precio: number;
    url: string;
    ventas?: number;
    descuento?: number;
    dosxuno?: boolean;
}

export interface ListaComplementosElegidos {
    titulo: string;
    complementos: Complemento[];
}

export interface Complemento {
    nombre: string;
    precio: number;
    isChecked?: boolean;
    deshabilitado?: boolean;
}

export interface RepartidorPreview {
    calificaciones: number;
    foto: string;
    id: string;
    nombre: string;
    promedio: number;
    telefono: string;
}

export interface RepartidorExternoDetalles {
    habilitado: boolean;
    licencia: string;
    pass: string;
    user: string;
    vehiculo: string;
}

export interface RepartidorInfo {
    preview: RepartidorPreview;
    detalles: RepartidorExternoDetalles;
}

export interface NotificacionNuevoPedido {
    idPedido: string;
    idNegocio: string;                                
    negocio: string;                              
    negocio_direccion: string;                         
    negocio_lat: number;                               
    negocio_lng: number;                               
    cliente: string;         
    cliente_direccion: string;                       
    cliente_lat: number;                             
    cliente_lng: number;
    createdAt: number;
    notificado: number;
    segundos_left?: number; 
    region?: string;    
}

export interface MensajeCliente {
    isMe: boolean;
    createdAt: number;
    idPedido: string;
    msg: string;
    idRepartidor: string;
    nombre: string;
    foto: string;
}

export interface MensajeRepOSop {
    isMe: boolean;
    createdAt: number;
    msg: string;
    idCliente: string;
    repartidor: string;
}