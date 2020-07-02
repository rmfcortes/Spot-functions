import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';

admin.initializeApp();
const cors = require('cors')({origin: true});
const conekta = require('conekta');

conekta.api_key = 'key_J1cLBV6qz5G5PsGBKP8yKQ';
conekta.api_version = '2.0.0';
conekta.locale = 'es';


// Pagos
exports.request = functions.https.onRequest((request, response) => {
    cors(request, response, () => {
        response.set('Access-Control-Allow-Origin', '*');
        response.set('Access-Control-Allow-Credentials', 'true');
        const origen = request.body.origen;
        const data = request.body.data;
        console.log(origen);
        console.log(data);
        if (origen === 'newCard') {
            return newCard(data)
            .then(() => response.status(200).send('Bien hecho esponja'))
            .catch(err => response.status(400).send('No pudimos completar el registro ' + err))
        } else {
            return doCharge(data)
            .then(() => response.status(200).send('Cargo autorizado'))
            .catch((err: any) => response.status(400).send('No pudimos hacer el cargo ' + err))
        }

    });
})

function newCard(cliente: ClienteToken) {
    let formaPago: any
    return admin.database().ref(`usuarios/${cliente.idCliente}/forma-pago/idConekta`).once('value')
    .then(res => res.val())
    .then(idConekta => {
        console.log(idConekta);
        if (!idConekta) {
            return createUser(cliente)
        }
        return addCard(idConekta, cliente.token)
    })
    .then((customer: any) => formaPago = customer)
    .then(() => admin.database().ref(`usuarios/${cliente.idCliente}/forma-pago/idConekta`).set(formaPago.idConekta))
    .then(() => admin.database().ref(`usuarios/${cliente.idCliente}/forma-pago/nueva`).set(formaPago.idCard))
    .catch(err => console.log(err))
}

function createUser(cliente: ClienteToken) {
    return new Promise(async (resolve, reject) => {
        try {
            const clienteInfo = await admin.auth().getUser(cliente.idCliente)
            if (clienteInfo.phoneNumber) {
                conekta.Customer.create({
                    'name': cliente.name,
                    'email': clienteInfo.email,
                    'phone': clienteInfo.phoneNumber,
                    'payment_sources': [{
                    'type': 'card',
                    'token_id': cliente.token
                    }]
                })
                .then((customer: any) => {
                    console.log(customer.toObject());
                    const newCliente = {
                        idCard: customer.toObject().default_payment_source_id,
                        idConekta: customer.toObject().id
                    }
                    console.log(newCliente);
                    resolve(newCliente)
                })
                .catch((err: any) => {
                    console.log(err)
                    reject(err)
                })
            } else {
                conekta.Customer.create({
                    'name': cliente.name,
                    'email': clienteInfo.email,
                    'payment_sources': [{
                        'type': 'card',
                        'token_id': cliente.token
                    }]
                })
                .then((customer: any) => {
                    console.log(customer.toObject());
                    const newCliente = {
                        idCard: customer.toObject().default_payment_source_id,
                        idConekta: customer.toObject().id
                    }
                    console.log(newCliente);
                    resolve(newCliente)
                })
                .catch((err: any) => {
                    console.log(err)
                    reject(err)
                })

            }
        } catch (error) {
            console.log(error);
            reject(error)
        }
    });
}

function addCard(idConekta: string, token: string) {
    return new Promise((resolve, reject) => {
        conekta.Customer.find(idConekta, function(_err: any, _customer: any) {
            _customer.createPaymentSource({
                type: 'card',
                token_id: token
            }, function(erre: any, res: any) {
                console.log('Tarjeta agregada');
                console.log(res);
                const newCliente = {
                    idCard: res.id,
                    idConekta: idConekta
                }
                resolve(newCliente)
            })
        })
    });
}

function doCharge(pedido: Pedido) {
    console.log('Do charge');
    const items: Item[] = []
    let idConekta: string;
    return new Promise((resolve, reject) => {        
        return admin.database().ref(`usuarios/${pedido.cliente.uid}/forma-pago/idConekta`).once('value')
        .then((snp) => snp.val())
        .then(idCon => idConekta = idCon)
        .then(() => conekta.Customer.find(idConekta))
        .then(cliente => {
            console.log(pedido.formaPago.id);
            cliente.update({
                default_payment_source_id: pedido.formaPago.id
            },
            function (err: any, customer: any){
                if (err) {
                    console.log(err);
                    reject(err)
                }
                console.log(customer.toObject());
                for (const producto of pedido.productos) {
                    console.log(producto);
                    const item: Item = {
                        id: producto.id,
                        name: producto.nombre,
                        unit_price: producto.total * 100,
                        quantity: 1
                    }
                    items.push(item)
                }
                console.log(items);
                conekta.Order.create({
                    currency: 'MXN',
                    customer_info: {
                        customer_id: idConekta
                    },
                    line_items: items,
                    charges: [{
                        payment_method: {
                            type: 'default'
                          } 
                    }]
                })
                .then((result: any) => {
                    console.log('Cargo autorizado');
                    console.log(result);
                    console.log(result.toObject());
                    resolve(true)
                })
                .catch((erra: any) => {
                    console.log('Error');
                    console.log(erra);
                    console.log(erra.details[0].message)
                    reject(erra.details[0].message)
                })
            })
        })
    });
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
        const negocio = pedido.negocio
        const categoria = pedido.categoria
        const region = await getRegion(idNegocio)
        pedido.productos.forEach(async (p: any) => {
            const vendidos =  {
                categoria,
                descripcion: p.descripcion,
                id: p.id,
                idNegocio: negocio.idNegocio,
                nombre: p.nombre,
                nombreNegocio: negocio.nombreNegocio,
                precio: p.precio,
                url: p.url,
            }
            await admin.database().ref(`vendidos/${region}/${p.id}/ventas`).transaction(ventas => ventas ? ventas + p.cantidad : p.cantidad)
            await admin.database().ref(`vendidos/${region}/${p.id}`).update(vendidos)
        })
        const date = await formatDate(pedido.createdAt)
        await admin.database().ref(`pedidos/activos/${idNegocio}/detalles/${idPedido}`).set(pedido)
        await admin.database().ref(`pedidos/activos/${idNegocio}/cantidad`).transaction(cantidad => cantidad ? cantidad + 1 : 1)
        await admin.database().ref(`pedidos/historial/${pedido.region}/por_fecha/${date}/${idPedido}`).set(pedido)
        await admin.database().ref(`pedidos/seguimiento_admin/${date}/${idPedido}`).set(pedido)
        return admin.database().ref(`tokens/${idNegocio}`).once('value')
        .then(data => {
            const token = data.val()
            if (token) {
                return sendFCM(token, 'Nuevo pedido')
            } else {
                return null;
            }
        })
        .catch(err => console.log(err));
    })

exports.pedidoAceptadoOrRepartidorAsignado = functions.database.ref('pedidos/activos/{idNegocio}/detalles/{idPedido}')
    .onUpdate(async (change, context) => {
        const idPedido = context.params.idPedido
        const after: Pedido = change.after.val()
        const before: Pedido = change.before.val()
        if (before === after) return null
        let recienAceptado = false
        // Lógica pedido aceptado
        if (!before.aceptado && after.aceptado) {
            recienAceptado = true
            const idCliente = after.cliente.uid
            if (after.entrega === 'inmediato') {
                const avance2: Avance[] = [
                    {
                        fecha: after.aceptado,
                        concepto: `${after.negocio.nombreNegocio} ha aceptado tu pedido`
                    },
                    {
                        fecha: after.aceptado,
                        concepto: `${after.negocio.nombreNegocio} está preparando tus productos`
                    },
                    {
                        fecha: 0,
                        concepto: `El repartidor tiene tus productos y está en camino`
                    },
                    {
                        fecha: 0,
                        concepto: `El repartidor ha llegado a tu domicilio`
                    },
                    {
                        fecha: 0,
                        concepto: `Pedido entregado`
                    },
                ]
                await admin.database().ref(`usuarios/${idCliente}/pedidos/activos/${idPedido}/avances`).set(avance2)
            } else {
                const avance: Avance = {
                    fecha: Date.now(),
                    concepto: `${after.negocio.nombreNegocio} ha aceptado tu pedido`
                }
                await admin.database().ref(`usuarios/${idCliente}/pedidos/activos/${idPedido}/avances`).push(avance)
            }
            const date = await formatDate(after.createdAt)
            await admin.database().ref(`usuarios/${idCliente}/pedidos/activos/${idPedido}`).set(after)
            await admin.database().ref(`pedidos/historial/${after.region}/por_fecha/${date}/${idPedido}`).update(after)
            await admin.database().ref(`pedidos/activos/${after.negocio.idNegocio}/detalles/${idPedido}`).update(after)
            if (after.repartidor) await admin.database().ref(`pedidos/seguimiento_admin/${date}/${idPedido}`).remove()
            else await admin.database().ref(`pedidos/seguimiento_admin/${date}/${idPedido}`).update(after)
            return admin.database().ref(`usuarios/${idCliente}/token`).once('value')
            .then(dataVal => dataVal ? dataVal.val() : null)
            .then(token => token ? sendPushNotification(token, `${after.negocio.nombreNegocio} está preparando tu pedido`) : null)
            .catch((err) => console.log(err))
        }

        // Lógica repartidor asignado
        if (before.repartidor !== after.repartidor && after.repartidor && !recienAceptado) {
            const idNegocio = context.params.idNegocio
            return admin.database().ref(`pedidos/activos/${idNegocio}/detalles/${idPedido}`).once('value')
            .then(dataVal => dataVal.val())
            .then(async (pedido: Pedido) => {
                pedido.negocio.idNegocio = idNegocio
                const idCliente = pedido.cliente.uid
                const date = await formatDate(pedido.createdAt)
                await admin.database().ref(`usuarios/${idCliente}/pedidos/activos/${idPedido}/repartidor`).transaction(rep => {
                    if (rep) {
                        const error = 'este pedido ya tiene repartidor'
                        throw error
                    } else return after.repartidor
                })
                await admin.database().ref(`asignados/${after.repartidor?.id}/${idPedido}`).update(pedido)
                await admin.database().ref(`pedidos/activos/${after.negocio.idNegocio}/detalles/${idPedido}`).update(after)
                await admin.database().ref(`pedidos/historial/${pedido.region}/por_fecha/${date}/${idPedido}`).update(pedido)
                await admin.database().ref(`pedidos/seguimiento_admin/${date}`).remove()
                return admin.database().ref(`usuarios/${idCliente}/token`).once('value')
            })
            .then(tokenVal => tokenVal ? tokenVal.val() : null)
            .then(token => token ? sendPushNotification(token, 'Repartidor asignado: ' + after.repartidor?.nombre) : null)
            .catch(err => console.log(err))
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
                repartidor.distancia = await calculaDistancia(repartidor.lat, repartidor.lng, pedido.negocio.direccion.lat, pedido.negocio.direccion.lng)
            }
            repartidores.sort((a, b) => 
                a.pedidos_activos - b.pedidos_activos ||
                a.last_notification - b.last_notification ||
                a.last_pedido - b.last_pedido ||
                b.promedio - a.promedio ||
                a.distancia - b.distancia)
            repartidorId = repartidores[0].id
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
        .then(() => sendFCMPedido(repartidores[0].token, 'Tienes un nuevo pedido. Gana: $' + pedido.envio + pedido.propina, pedido))
        .then(() => pedido.last_notificado = repartidorId)
        .then(() => {
            const notification = {
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
                notificado: pedido.last_notification.toString(),
                ganancia: pedido.envio.toString(),
                propina: pedido.propina.toString()
            }
            return admin.database().ref(`notifications/${repartidorId}/${idPedido}`).set(notification)
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
            return admin.database().ref(`usuarios/${pedido.cliente.uid}/pedidos/activos/${pedido.id}/repartidor`).transaction(rep => {
                if (rep || pedido && pedido.repartidor) {
                    console.log('Pedido tomado por otro repartidor')
                    throw sendFCM(repartidor.token, 'El pedido ha sido tomado por otro repartidor')
                } else return repartidor
            })
        })
        .then(() => admin.database().ref(`asignados/${idRepartidor}/${pedido.id}`).set(pedido))
        .then(() => admin.database().ref(`pedidos/seguimiento_admin/${date}/${idPedido}`).remove())
        .then(() => admin.database().ref(`repartidores_asociados_info/${pedido.region}/preview/${idRepartidor}/last_pedido`).set(Date.now()))
        .then(() => admin.database().ref(`pedidos/historial/${notificacion.region}/por_fecha/${date}/${idPedido}`).update(pedido))
        .then(() => admin.database().ref(`pedidos/activos/${pedido.negocio.idNegocio}/detalles/${idPedido}`).update(pedido))
        .then(() => admin.database().ref(`notifications/${pedido.last_notificado}/${idPedido}`).remove())
        .then(() => admin.database().ref(`pendientes_aceptacion/${idRepartidor}/${idPedido}`).remove())
        })
        .catch(err => console.log(err))
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
                await admin.database().ref(`functions/${region}/${idNegocio}`).update(cal)
                return admin.database().ref(`busqueda/${region}/${idNegocio}`).update(cal)
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


        // Propios de administración, registros

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
            });
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
              };
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
              entrega: negocio.entrega,
              telefono: negocio.telefono,
              formas_pago: negocio.formas_pago
            }
            await admin.database().ref(`negocios/datos-pedido/${negocio.categoria}/${negocio.id}`).update(datosPedido)
            }
            if (negocio.preparacion && negocio.tipo === 'productos') {
                await admin.database().ref(`preparacion//${negocio.id}`).set(negocio.preparacion)
            }

                // Palabras búsqueda
            let claves = ''
            claves = claves.concat(negocio.nombre + ' ')
            claves = claves.concat(negocio.categoria)
            claves = claves
                .toLocaleLowerCase()
                .split(' ')
                .filter((item, i, allItems) => i === allItems.indexOf(item))
                .join(' ')
            await admin.database().ref(`busqueda/${region}/${negocio.id}/palabras`).set(claves)

                //Listoforo
            return admin.database().ref(`result_negocios/${region}/${idTemporal}`).push('ok')
        } catch (error) {
            return admin.database().ref(`result_negocios/${region}/${idTemporal}`).push(error.errorInfo.code)
        }
    })

exports.onProdEliminado = functions.database.ref('negocios/{tipo}/{categoria}/{idNegocio}/{pasillo}/{idProducto}')
    .onDelete(async (snapshot, context) => {
        const idNegocio = context.params.idNegocio;
        const idProducto = context.params.idProducto;
        const producto = snapshot.val();
        if (producto.mudar) return
        const region = await getRegion(idNegocio)
        return admin.database().ref(`vendidos/${region}/${idProducto}`).remove()
    });

exports.onProdEdit = functions.database.ref('negocios/productos/{categoria}/{idNegocio}/{subCategoria}/{idProducto}')
    .onUpdate(async (change, context) => {
        const idProducto = context.params.idProducto
        const idNegocio = context.params.idNegocio
        const after = change.after.val()
        const before = change.before.val()
        if (before === after) return null
        const region = await getRegion(idNegocio)
        return admin.database().ref(`vendidos/${region}/${idProducto}`).once('value', snapshot => {
        if (snapshot.exists()) return admin.database().ref(`vendidos/${region}/${idProducto}`).update(after)
        else return null
       })
    })

exports.onCategoriaEdit = functions.database.ref('perfiles/{idNegocio}/categoria')
    .onUpdate(async (change, context) => {
        const idNegocio = context.params.idNegocio
        const after = change.after.val()
        const before = change.before.val()
        if (before === after) return null
        const region = await getRegion(idNegocio)
        return admin.database().ref(`vendidos/${region}`).orderByChild('idNegocio').equalTo(idNegocio).once('value', snapshot => {
            snapshot.forEach(child => {
                const childData = child.val()
                const childKey = child.key
                childData.categoria = after
                admin.database().ref(`vendidos/${region}/${childKey}`).update(childData)
                .then(() => true)
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
        return admin.database().ref(`vendidos/${region}`).orderByChild('idNegocio').equalTo(idNegocio).once('value', snapshot => {
            snapshot.forEach(child => {
                const childData = child.val()
                const childKey = child.key
                childData.nombreNegocio = after
                admin.database().ref(`vendidos/${region}/${childKey}`).update(childData)
                .then(() => true)
                .catch(() => null)
            });
        });
    })

exports.onNewRepartidor = functions.database.ref('nuevoColaborador/{idNegocio}/{idColaborador}')
    .onCreate(async (snapshot, context) => {
        const idNegocio = context.params.idNegocio
        const repartidor = snapshot.val()
        try {
            const newUser = await admin.auth().createUser({
                disabled: false,
                displayName: repartidor.detalles.user,
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
    });

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


// Functions

function calculaDistancia( lat1: number, lng1: number, lat2: number, lng2: number ): Promise<number> {
    return new Promise ((resolve, reject) => {
        const R = 6371; // Radius of the earth in km
        const dLat = deg2rad(lat2 - lat1);
        const dLon = deg2rad(lng2 - lng1);
        const a =
            Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2)
            ;
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        const mts = R * c * 1000; // Distance in mts
        resolve(mts);
    });
}

function deg2rad( deg: number ) {
    return deg * (Math.PI / 180);
}

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
                    .then(() => admin.database().ref(`perfiles/${idNegocio}`).update({abierto: false}))
                    .then(() => admin.database().ref(`horario/analisis/${dia}/${idNegocio}`).update({abierto: false}))
                    .then(() => admin.database().ref(`functions/${region}/${idNegocio}`).update({abierto: false}))
                    .then(() => admin.database().ref(`busqueda/${region}/${idNegocio}`).update({abierto: false}))
                    .then(() => admin.database().ref(`isOpen/${region}/${idNegocio}/abierto`).set(false))
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
                    .then(() => admin.database().ref(`perfiles/${idNegocio}`).update({abierto: true}))
                    .then(() =>admin.database().ref(`horario/analisis/${dia}/${idNegocio}`).update({abierto: true}))
                    .then(() => admin.database().ref(`functions/${region}/${idNegocio}`).update({abierto: true}))
                    .then(() => admin.database().ref(`busqueda/${region}/${idNegocio}`).update({abierto: true}))
                    .then(() => admin.database().ref(`isOpen/${region}/${idNegocio}/abierto`).set(true))
                    .catch(err => console.log(err));
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

function sendFCM(token: string, mensaje: string) {
    const payload: admin.messaging.MessagingPayload = {
        notification: {
            title: 'Spot',
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

function sendFCMPedido(token: string, mensaje: string, pedido: Pedido) {
    const payload: admin.messaging.MessagingPayload = {
        notification: {
            title: 'Spot',
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
            notificado: pedido.last_notification.toString(),
            ganancia: pedido.envio.toString(),
            propina: pedido.propina.toString()
        }
      };
      const options = {
          priority: "high"
      }
      return admin.messaging().sendToDevice(token, payload, options)
}

function getRegion(idNegocio: string) {
    return new Promise((resolve, reject) => {
        admin.database().ref(`perfiles/${idNegocio}/region`).once('value')
        .then(region => {
            resolve(region.val());
        })
        .catch(err => {
            console.log(err);
            reject(err);
        });
    });
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
    abierto: boolean
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
    repartidores_propios: any
}

export interface Pedido {
    aceptado: number;
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
    repartidor?: Repartidor;
    cancelado_by_user?: number;
    cancelado_by_negocio?: number;
    cancelado_by_repartidor?: number;
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
    total: number;
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